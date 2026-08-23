# Architecture

Sxratch is a browser DJ rig + multitrack studio built in **vanilla ES modules** — no
framework, and **no build step is required to run it** (`npm start` serves the source).
A production build (`npm run build`) bundles and minifies into `dist/`. This document
maps the threads, the audio signal flow, and what each module does.

## Threads & contexts

The work is deliberately spread across threads so input and audio never block on
rendering, and so the hand-driven scratch stays low-latency.

```
┌──────────────────────────── Main thread (UI) ────────────────────────────┐
│ app.js · ui.js · input.js · midi.js · haptics.js · practice.js           │
│ daw.js · daw-engine.js (look-ahead scheduler) · waveform.js (geometry)   │
│ - DOM, pointer/keyboard/MIDI input, persistence and animation            │
│ - builds the deck and PAD Web Audio graphs                              │
└──────┬────────────────┬────────────────┬─────────────────┬───────────────┘
       │ postMessage +  │ SharedArrayBuffer / postMessage  │ transferControlToOffscreen
       │ audio blocks   │ (scratch control + state)        │
       ▼                ▼                ▼                 ▼
┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐
│ PAD capture  │ │ scratch A/B  │ │ limiter-     │ │ waveform-worker.js   │
│ AudioWorklet │ │ AudioWorklets│ │ processor    │ │ (+ waveform-draw.js) │
│ while record │ │ audio thread │ │ master bus   │ │ Web Worker /         │
└──────────────┘ └──────────────┘ └──────────────┘ │ OffscreenCanvas       │
                                                   └──────────────────────┘

Offline: `daw-engine.js` rebuilds the PAD graph in an `OfflineAudioContext` for
master/stem exports, sampler bounces, and send-to-deck renders.
```

- **Main thread** — DOM/input, graph construction, and PAD's short look-ahead event
  scheduler. `app.js#frameLoop` drives the decks' platters, meters, FFT visualizers and
  dirty waveforms; PAD has its own animation loop for its playhead, clock and meters.
- **Two scratch AudioWorklets** — one per deck, the variable-rate playback engine.
- **One limiter AudioWorklet** — the master look-ahead brickwall limiter.
- **PAD capture AudioWorklet** — registered dynamically only while recording audio;
  it transfers raw input blocks to `daw-engine.js`, with a `ScriptProcessor` fallback.
- **One waveform Web Worker** — owns the decks' `OffscreenCanvas`es and does the
  per-frame stroking off the main thread (one worker instance per `Waveform`).
- **OfflineAudioContext** — uses the same PAD scheduling and mix path as realtime
  playback, then returns an `AudioBuffer` for bounce/export operations.

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

PAD (`daw-engine.js`):

```
Synth/drum voices ─┐
Audio regions ─────┼→ per-track drive → EQ → compressor → pan → fader/mute
Live input monitor ┘                                      ├→ shared reverb/delay sends
                                                          └→ DAW mix input
Shared returns ─────────────────────────────────────────────→ DAW mix input
DAW mix input → master 3-band EQ → glue compressor → fader/meter
              → SXRATCH masterBus → global limiter → destination
```

Each track has one reusable live chain. Reverb and tempo-synced ping-pong delay are
shared buses with post-fader sends; volume, pan, and both send levels can be automated.
Metronome/count-in clicks bypass the DAW mix controls but still enter the shared output.

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

## PAD — Studio DAW (`daw.js`, `daw-engine.js`)

PAD is one global, quarter-note-beat timeline. `daw.js` owns the versioned song object,
DOM, selection, undo/redo, editor panels, persistence and export/deck integrations;
`daw-engine.js` owns realtime playback/recording and offline rendering. The engine holds
a reference to the mutable song and re-reads it on each scheduler window, so most edits
become audible during playback without a resync.

The core model is:

```
Song   = { bpm, ts, loop, markers, tracks, buses, master, view }
Track  = { kind, gain, pan, mute, solo, fx, sends, automation, regions }
Region = MIDI notes | drum hits | audio clip reference, all with start/length in beats
```

- **Tracks** — `midi` tracks select a Chords & Keys, Bass, Lead, or Chorus/Atmosphere
  family and a factory patch from `synth.js`; `drums` tracks select a built-in kit;
  `audio` tracks refer to decoded clip buffers kept outside the JSON song model. Tracks
  can be renamed, coloured, reordered, duplicated, muted, soloed and armed.
- **Arrangement editing** — `daw-model.js` supplies snap/quantize, move, trim, split,
  clipboard, fade, loop-partition and automation helpers. `daw.js` layers select/draw/
  split tools, multi-region edits, markers, ruler looping, zoom/follow and the undo
  history on top.
- **Editors** — MIDI and drum regions open a piano/drum roll with draw/erase,
  multi-selection, velocity, move/resize, transpose and quantize. Audio regions expose
  clip gain, fades, source offset, and raw versus tempo-following repitch playback. A
  virtual keyboard auditions the selected instrument and also feeds MIDI recording.
- **Recording** — one armed track records at a time. Audio input is captured as raw PCM
  while the remaining arrangement plays; capture timing plus browser/device latency and
  the track's manual offset place the waveform. MIDI/drum takes collect virtual-keyboard
  or hardware-MIDI events. The metronome, 0/1/2-bar count-in, live recording preview,
  loop-pass take lanes and active-take switching are shared across both paths.
- **Devices and mixer** — each track has drive, five-control EQ, compressor, pan/fader,
  shared reverb/delay sends and mute/solo. The mixer adds per-track meters and FX bypass,
  shared return controls, master EQ/fader/meter/limiter status, and MIDI Learn for CC
  control. Automation lanes cover volume, pan and the two sends.
- **Delivery** — `OfflineAudioContext` renders the master to Deck A/B or WAV, isolates
  each track for stem WAVs, and bounces the selected track into a SXRATCH sampler pad.
  `midiexport.js` writes tempo, meter, markers and non-audio regions to `.mid`; JSON
  import/export transfers the song document without embedding audio clip bytes.

## Persistence

- **IndexedDB (`idb-store.js`)** — the `sxratch` database stores the current versioned
  DAW document, up to three previous revisions for **Recover previous save…**, and raw
  `Float32Array` channel data for imported/recorded clips. Project clips are pinned;
  only non-project sampler data participates in the 50 MB LRU budget.
- **Autosave policy** — `daw.js` debounces edits, writes a synchronous versioned
  `sxratch.daw` `localStorage` snapshot first, then commits the document and recovery
  revision to IndexedDB. Startup normally prefers IndexedDB, but a fallback marker lets
  a newer local snapshot win after an IndexedDB failure. Visibility/page-hide events
  flush pending work.
- **Other `localStorage` state** — `sxratch.config` holds deck key/gesture/MIDI/haptics
  settings; `sxratch.dawpanels`, `sxratch.dawmidi`, and the Studio tour key hold PAD UI
  layout, mixer CC mappings, and guidance progress. A legacy `sxratch.song` document is
  read once and migrated into tracks/regions when no DAW save exists.
- **Portability boundary** — JSON export contains the DAW document and its clip IDs, not
  PCM data. An imported JSON project therefore needs its referenced audio to exist in
  the same browser; master/stem WAV exports are the portable audio deliverables.

## Cross-origin isolation

`server.js` sends `Cross-Origin-Opener-Policy: same-origin` +
`Cross-Origin-Embedder-Policy: credentialless`. This enables `SharedArrayBuffer` (the
low-latency scratch channel) while `credentialless` keeps permitted cross-origin audio
sources usable without requiring CORP headers from them. Everything degrades gracefully
when isolation isn't available.

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

`npm test` runs `node:test` across the scratch/limiter kernels, BPM and timing helpers,
synth DSP, DAW model/engine/guidance seams, IndexedDB/store policy, instrument-roster
guarantees, and shared theory/WAV helpers. `npm run test:e2e` builds `dist/`, starts the
source and production servers on separate ports, then uses Playwright/Chromium to cover
booth startup, view switching, built-in deck demos, DAW edit persistence, runtime-console
health, and production boot. `npm run test:all` is the CI entry point in
`.github/workflows/ci.yml`. `jsconfig.json` enables editor `checkJs`.
