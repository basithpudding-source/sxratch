# Architecture

Sxratch is a browser DJ rig + studio composer built in **vanilla ES modules** — no
framework, and **no build step is required to run it** (`npm start` serves the source).
A production build (`npm run build`) bundles and minifies into `dist/`. This document
maps the threads, the audio signal flow, and what each module does.

## Threads & contexts

The work is deliberately spread across threads so input and audio never block on
rendering, and so the hand-driven scratch stays low-latency.

```
┌────────────────────────── Main thread (UI) ──────────────────────────┐
│  app.js  ·  ui.js  ·  input.js  ·  midi.js  ·  haptics.js            │
│  songbuilder.js  ·  practice.js  ·  waveform.js (geometry)           │
│  - DOM, pointer/keyboard/MIDI input, settings, RAF animation loop    │
│  - builds the Web Audio graph (audio-engine.js)                      │
└───────┬───────────────┬────────────────┬───────────────┬────────────┘
        │ postMessage    │ SharedArrayBuffer │ postMessage   │ transferControlToOffscreen
        ▼ + SAB          ▼ (jog control)    ▼               ▼
┌─────────────────┐ ┌─────────────────┐ ┌──────────────┐ ┌──────────────────────┐
│ scratch-        │ │ scratch-        │ │ limiter-     │ │ waveform-worker.js   │
│ processor (A)   │ │ processor (B)   │ │ processor    │ │ (+ waveform-draw.js) │
│ AudioWorklet    │ │ AudioWorklet    │ │ AudioWorklet │ │ Web Worker /         │
│ — audio thread  │ │ — audio thread  │ │ master bus   │ │ OffscreenCanvas      │
└─────────────────┘ └─────────────────┘ └──────────────┘ └──────────────────────┘

Offline: songbuilder renders arrangements in a separate OfflineAudioContext.
```

- **Main thread** — everything DOM/input plus building the audio graph. A single
  `requestAnimationFrame` loop (`app.js#frameLoop`) drives platter rotation, VU meters,
  the FFT visualizers, and flushes dirty waveforms.
- **Two scratch AudioWorklets** — one per deck, the variable-rate playback engine.
- **One limiter AudioWorklet** — the master look-ahead brickwall limiter.
- **One waveform Web Worker** — owns the decks' `OffscreenCanvas`es and does the
  per-frame stroking off the main thread (one worker instance per `Waveform`).
- **OfflineAudioContext** — the PAD composer renders a whole song to an `AudioBuffer`
  ahead of time (for Preview / → Deck / WAV).

## Audio signal flow

Per deck (`audio-engine.js`):

```
ScratchWorklet → trim → EQ(low shelf → mid peak → high shelf)
              → DJ filter(LPF → HPF) → volume → BeatFX → analyser → crossfade gain
                                                                        │
Deck A ───────────────────────────────────────────────────────────────┤
Deck B ───────────────────────────────────────────────────────────────┤
Sampler (8 one-shot pads) ─────────────────────────────────────────────┤
                                                                        ▼
                                          masterBus → master → LIMITER → destination
```

- **Crossfade** uses equal-power / linear / sharp-cut curves (`theory.crossfadeGains`).
- **BeatFX** (per deck): Echo / Reverb / Flanger / Phaser as a wet/dry insert.
- **Limiter**: `limiter-processor.js` (look-ahead, 3 ms, channel-linked) with a
  `DynamicsCompressor` fallback if the worklet can't load.

## The scratch engine (`scratch-processor.js`)

A standard `AudioBufferSourceNode` only plays forward. The custom worklet keeps its own
floating-point playhead and reads the track with **4-point Catmull-Rom cubic
interpolation** at a signed, variable rate, so it can reverse, stall and recover.

- **Control model** — while "touching", hand velocity drives the rate (decayed between
  updates so a still finger = a stopped record); released, a simulated motor eases the
  rate back to base (spin-up) or zero (brake inertia). BRAKE/SPIN are transport FX.
- **Jog input** — when the page is cross-origin isolated, jog velocity arrives over a
  per-deck **`SharedArrayBuffer`** (`f32[0]` velocity, `i32[1]` generation via
  `Atomics`) that the worklet polls once per 128-sample block; otherwise it falls back
  to `postMessage`. The main thread feeds it **coalesced pointer events** for finer
  resolution.
- **Output** — position is posted back to the main thread ~25×/s; the platter and
  waveform are extrapolated at full frame rate from the last post.

## Rendering (`waveform.js`, `waveform-worker.js`, `waveform-draw.js`)

`Waveform` keeps the peak data + geometry on the main thread (for pointer hit-testing:
`positionAtX`, `cueAt`, scrubbing). The actual pixels are drawn by `waveform-worker.js`
on a transferred `OffscreenCanvas`, using the shared `drawWaveform()` routine — with a
main-thread 2D fallback when OffscreenCanvas/module workers aren't available. State is
`dirty`-flagged and flushed once per RAF frame, so idle decks don't repaint.

## Input (`input.js`, `midi.js`, `haptics.js`)

- **Pointer** — scratch pads and waveform scrubbing use Pointer Events with capture and
  `getCoalescedEvents()`; faders/knobs are custom widgets with tick scales.
- **Trackpad gestures** — held modifier keys arm a deck; one-finger move scratches, two
  fingers crossfade (remappable in Settings).
- **Keyboard** — fully remappable transport / cues / crossfader / sampler bindings.
- **Web MIDI** — `MidiInput` parses note/CC/pitch-bend and maps them (crossfader,
  volumes, EQ, jog→scratch, notes→sampler pads). A default map plus **MIDI-Learn**
  (stored in `config.midi`). No-ops where Web MIDI is unsupported.
- **Haptics** — `navigator.vibrate` on pad hits / cue drops (feature-detected).

## PAD — Song Builder (`songbuilder.js`)

An ordered timeline of **sections**; each section has key / time-signature / bars / step
grid and five lanes: **Chords, Bass, Lead, Drums, Sampler**.

- **Synthesis vs samples** — every lane plays through a small wrapper
  (`voiceChord/voiceBass/voiceLead/voiceDrum`) that uses the sampled engine when it's on
  and the instrument is loaded, else the oscillator/Karplus-Strong/noise voice.
- **Sampled instruments** (`instruments.js`) — `SampleBank` loads General MIDI
  instruments from the gleitz/MIDI.js soundfont CDN (one file per instrument, decoding
  only the notes a song uses) and **drum kits** from the Tone.js one-shot CDN. Buffers
  are reusable across the live and offline contexts.
- **Sampler lane** — ports the live SXRATCH sampler-pad buffers (`getSampler` dep) into
  an in-memory store; rows are `{ sampleId, transpose, defaultLen, placements }` and
  play a pitched, gated buffer. Drag length = playback length.
- **Rendering** — `renderSections()` schedules everything into an `OfflineAudioContext`
  and **caches** the result (LRU, keyed by engine + tempo + serialized sections).

## Persistence

- **`localStorage`** — `sxratch.config` (key/gesture/MIDI/haptics settings) and
  `sxratch.song` (the arrangement; auto-save is debounced and flushed on `pagehide`).
- **Not persisted** — decoded audio buffers (sampler pads, ported samples, soundfonts).
  These are session-scoped; the Sampler lane keeps placements but you re-import pad
  samples after a reload (rows show ⚠ until then).

## Cross-origin isolation

`server.js` sends `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: credentialless`. This enables `SharedArrayBuffer` (the
low-latency scratch channel) while `credentialless` keeps the cross-origin sample CDNs
working without requiring CORP headers from them. Everything degrades gracefully when
isolation isn't available.

## Build, PWA & packaging

- **`build.js`** (esbuild) bundles `app.js` and minifies CSS into `dist/`, builds each
  URL-loaded worklet/worker (`scratch-processor`, `limiter-processor`, `waveform-worker`)
  as a separate entry at the **same path** so runtime `addModule()` / `new Worker()`
  references still resolve, and copies static assets. `server.js --dist` serves it.
- **PWA** — `manifest.webmanifest` + `sw.js` (network-first, offline app-shell cache,
  tolerant precache so the bundled layout works). Installable on desktop/Android.
- **TWA** — `twa-manifest.json` + `.well-known/assetlinks.json` make it Play-Store
  packageable via Bubblewrap; see [TWA.md](TWA.md).

## Tests

`npm test` runs `node:test` over the pure helpers in `theory.js` (crossfade curves,
note↔MIDI, nearest-sample, Catmull-Rom, WAV quantization). `jsconfig.json` enables
editor `checkJs`.
```
