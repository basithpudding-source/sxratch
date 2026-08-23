# SXRATCH / PAD

A browser-based DJ rig with two modes, switched from the **SXRATCH / PAD** toggle
in the top bar:

- **SXRATCH** — the DJ decks: **scratching and mixing** with two decks, per-deck vertical BeatFX modules, split frequency visualizers, crossfader curves, Hamster Mode, global mix recording, preloaded synthetic presets, and loop region sampler mapping, for **desktop** (mouse / trackpad) and **mobile** (touch). Drag a platter to scratch; slide the center crossfader to blend.
- **PAD** — a **multitrack studio**: arrange synth, drum and audio regions on a musical timeline, record microphone/interface audio or live MIDI, edit notes and clips, automate and mix the tracks, then send the result to a deck, a sampler pad, WAV stems, or a MIDI file.

## PAD · Studio DAW

Open **PAD** from the top bar. The Studio uses one beat-based timeline with a global
tempo and time signature. Playback is realtime, so edits and mixer moves are heard
without waiting for a render; offline rendering is used only when bouncing or
exporting.

### Tracks, regions and arrangement

- **Track types** — add Chords & Keys, Bass, Lead, Chorus / Atmosphere, Drum Kit, or
  Audio tracks. Track headers support rename, recolour, drag-to-reorder, duplicate,
  delete, mute, solo, record-arm, automation, and live level meters. MIDI tracks use
  the built-in instrument roster in `js/synth.js`; drum tracks choose from the
  built-in kits; audio tracks can import a file or record an input.
- **Regions** — Select and Split work across MIDI, drum, and audio regions; Draw creates
  MIDI/drum regions. Drag a region to move it, pull either edge to trim/resize it, or use
  multi-select, copy/cut/paste, duplicate, delete, quantize, and grid/bar nudging.
  Audio files can also be dropped straight onto an audio lane.
- **Timeline** — choose a rhythmic snap grid or turn the magnet off for free
  positioning, zoom the arrangement, follow the playhead, add named markers, click
  the ruler to seek, and drag on it to define a loop. Tempo and meter are set in the
  transport.
- **History** — arrangement, editor, import, track, device and mixer changes use the
  Studio undo/redo history (`Ctrl+Z`, `Ctrl+Y`, or `Ctrl+Shift+Z`).

### Record and edit

- **Audio recording** — arm an Audio track, choose a microphone or interface, and
  press **●**. The other tracks play for overdubbing while PAD captures the input;
  optional monitoring, automatic latency alignment, and a per-track recording offset
  are available in Devices. The finished take lands as a waveform region.
- **MIDI and drum recording** — arm a synth or drum track and perform with the
  on-screen/QWERTY keyboard or a Web MIDI controller. Notes and drum hits are captured
  while the arrangement plays. The metronome and 0/1/2-bar count-in work for either
  recording type.
- **Loop takes** — recording across an active loop separates captured passes into
  alternate takes. Expand **TAKES** on the track and choose which pass is active.
- **Region editor** — double-click a synth or drum region to open its piano/drum roll.
  Draw, erase, multi-select, move, resize, transpose or quantize notes and edit their
  velocities. Audio regions open a waveform editor with clip gain, fade-in/out, and
  raw or tempo-following repitch playback.
- **Keyboard and Devices** — the playable keyboard can stay pinned while another
  lower panel is open. Devices selects the synth patch, drum kit, or audio input and
  exposes the track fader/pan plus EQ, compressor, distortion, and shared reverb/delay
  sends.

### Mix, automate and deliver

- **Automation** — each track can show editable lanes for volume, pan, reverb send,
  and delay send. Automation is piecewise-linear and drives both realtime playback
  and offline renders.
- **Mixer** — every channel has mute/solo, FX bypass, fader, pan, reverb/delay sends,
  and a meter. Shared Reverb and Delay returns feed a DAW master with three-band EQ,
  fader, glue compression, metering, and a safety limiter. MIDI Learn can map controller
  CCs to channel faders, pan, sends, and the master fader.
- **File menu** — send the master to Deck A/B, bounce the selected track to its
  corresponding SXRATCH sampler pad, download a master WAV, export one WAV stem per
  track, or export MIDI (tempo, meter, markers, synth notes, and GM-channel drum hits).
  Sending to a deck carries the exact BPM and creates hot cues from markers, or from
  region starts when no markers exist.
- **Project transfer and recovery** — JSON export/import carries the DAW document, but
  not recorded or imported audio bytes; those clips remain in this browser. **Recover
  previous save…** restores one of the retained checkpoints, and **New song** is
  immediately undoable.

PAD autosaves the versioned song document and audio clips to IndexedDB, with a
synchronous `localStorage` fallback for page close or storage failure. Imported and
recorded clips are pinned project data rather than disposable sampler cache entries.
On first use, a valid legacy `sxratch.song` section-builder save is migrated into
tracks and regions automatically.

## Run it

You need a local web server (the audio engine uses an `AudioWorklet`, which browsers
won't load from `file://`). Node is the only dependency-free option:

```bash
npm start
```

Then open **http://localhost:5173**.

To use it on your phone, make sure the phone is on the same Wi‑Fi, find your computer's
LAN IP (e.g. `192.168.1.x`), and open `http://<that-ip>:5173`. Set the port with
`PORT=8080 npm start` if 5173 is taken. Phones work in **both orientations**: landscape
gets the full controller, portrait gets a purpose-built stacked layout (waveforms on
top, both platters side by side, mixer below) — no forced rotation.

Useful scripts:

```bash
npm run build       # bundle/minify into dist/ for deployment
npm run start:dist  # serve the production build from dist/
npm test            # run the Node test suite
npm run test:e2e    # build, then smoke-test source + dist in Chromium
npm run test:all    # run both Node and browser suites
npm run icons       # regenerate icon-192.png and icon-512.png from icon.svg
```

Use Node **20.9 or newer**. After the first `npm install`, run
`npx playwright install chromium` once before the browser suite.

The dev server serves source ES modules directly. The production build keeps
URL-loaded worklets and workers at stable paths (`js/scratch-processor.js`,
`js/limiter-processor.js`, `js/waveform-worker.js`) while bundling the main app.

## How to play

**Desktop (trackpad — no clicking):**
- **Scratch** — hold a **Ctrl** key and move **one finger** up/down. Holding Ctrl
  "grabs" the record; one-finger vertical motion scratches it, proportional to the
  movement. The held Ctrl picks the deck (cursor position is ignored): hold
  **right** Ctrl (left hand scratches) → **Deck A**; hold **left** Ctrl (right hand
  scratches) → **Deck B**. The armed deck glows; release to let the platter spin
  back up.
- **Crossfade** — two fingers left/right (no Ctrl needed) moves the A↔B fader.
- **Slam** — right **Ctrl + Alt** throws the crossfader fully to **A**; left
  **Ctrl + Shift** throws it fully to **B** (while you scratch that deck solo).
  Release to snap it back to where it was.
- **One finger** just moves the cursor — it never scratches or moves a fader.

> Why Ctrl and not the trackpad halves? A browser only receives scroll deltas +
> the cursor position from a trackpad — it can't tell which side your fingers are
> physically on. The Ctrl keys give a reliable, cursor-independent way to pick a
> deck. (On a real touchscreen/phone the left/right split is literal.)

> Direction note: if "natural" scrolling makes a vertical swipe feel inverted,
> flip the sign on the scratch `rate` in `attachTrackpadGestures`
> ([`js/input.js`](js/input.js)). Sensitivities are options on that same call.

**Mouse / touch (also available everywhere):**
- **Scratch** — press and drag ← → on a platter. Left pad = Deck A, right = Deck B.
- **Crossfade** — slide the center fader (or `←` / `→` keys; `↓` re-centers).

**Mixer controls (Pioneer-style channel strip):** Each channel has **TRIM · HI · MID · LO · FILTER** knobs, a volume fader, and a dedicated vertical VU meter. 
* The **FILTER** is a single-knob DJ filter — centre is off, turning left sweeps a low-pass filter down, and turning right sweeps a high-pass filter up.
* The **tempo faders** sit beside each platter (vertical, ±8% adjustment in pitch/speed).
* EQ knobs, filters, volume, tempo, and the crossfader all feature a visual **tick scale**, large grab handles, and support **double-click** to snap them back to neutral. EQ knobs draw an active color arc indicating the amount of boost/cut applied.

**Independent Deck Beat FX:** Rather than a master FX unit, each deck (A and B) has its own independent BeatFX module integrated directly into its vertical mixer channel strip, next to the EQ and Filter knobs.
* Select from **ECHO / REVERB / FLANGER / PHASER** arranged in a clean vertical stack on desktop (and a compact 2x2 grid on mobile).
* Fine-tune the wet/dry mix with the **DEPTH** slider.
* Toggle the effect on or off using the **FX ON** button.
* Plus, each deck features scratch-worklet transport FX: **BRAKE** (hold to spin the record down to a stop, release to spin back up) and **SPIN** (triggers a back-spin flick).

**Split Deck Visualizers:** Inside the central crossfader section, Sxratch displays two independent frequency visualizers (`#viz-A` and `#viz-B`). They tap the pre-crossfader, post-volume, and post-FX audio signal of their respective decks. They render symmetrical, center-out frequency bars colored after each deck's theme (Cyan for Deck A, Pink for Deck B).

**Global Mix Recorder:** Capture your entire master performance by clicking the **🔴 REC** button in the header. The button label displays a live timer of the recording (e.g. `🔴 REC [1:42]`). Click it again to stop and automatically download your session as a compressed audio file (WebM/Opus in Chrome and Firefox, M4A in Safari).

**A note on tempo & pitch:** the tempo fader behaves like vinyl — speeding a track up raises its pitch, slowing it lowers it. This is a deliberate design choice (Sxratch is a scratch instrument first); there is currently no keylock/master-tempo mode.

**Preloaded Synthetic Presets:** Get scratching immediately without loading files using the **Presets** dropdown on either deck. Choose from:
* **Scratch Tool** — a synthesized classic vocal scratch sample.
* **100 BPM Beat** — a synthetic drum track for beatmatching practice.
* **Laser Preset** — a synthesized sci-fi sound effect.

**Transport, sync & both decks:** Each deck has **⏮ to-start**, **⏪/⏩ hold-to-rewind/fast-forward**, **CUE / SET / ▶**, and **SYNC** (matches the deck's BPM and aligns the beat phase to the other deck). The centre **▶❚❚ BOTH** button (or `Space`) plays/pauses both decks simultaneously; `T`/`Y` sync A→B / B→A.

**Extras & Sampler Pad Loop Mapping:**
* **Instant Doubles** — The **DBL** button copies a deck's loaded track, playhead position and BPM onto the other deck instantly for beat-juggling routines.
* **Live BPM readout** — each deck shows its **effective BPM** (track BPM × pitch fader). Tempo is detected automatically when you load a file (onset-envelope autocorrelation, `js/bpm.js`); presets and PAD renders carry their exact tempo. The readout shows `--` until a tempo is actually known — it never guesses.
* **A | B toolbar switch** — the centre toolbar (LINK · DBL · Presets · zoom) and the LOOP row are shared between decks; the **A | B** switch above the waveforms shows and sets which deck they control (it also follows the deck you last touched).
* **Sampler & Loop Region Mapping** — 8 pads in the center of the mixer. Click an empty pad to load an audio file, click again to trigger it, **■** to stop it (or **■ STOP** to stop all), and double-click to clear. Adjust sampler volume with the fader.
* **→ PAD Loop Mapping** — Create a loop on Deck A or B (using the auto **4-beat** loop or manual **IN / OUT** points). A **→ PAD** button appears in the loop row. Click **→ PAD** to enter Mapping Mode (the button highlights, and all sampler pads pulse green), then click a sampler pad (1-8) to extract and map that exact looped audio region. The pad's name updates to `[Track Name]... [Slice]`, and clicking the pad triggers the sliced region independently. Pads are triggerable via keys (default A S D F G H J K) and customizable in **⚙**.

**Loops:** Per deck: **AUTO 4-beat** loop (beat-accurate using the deck's BPM), manual **IN / OUT** points, **½ / 2×** to resize, and **EXIT** to release the loop. Active loop regions are highlighted on the scrolling waveform. Use `R` / `U` to toggle auto-loops on A / B.

(Still hardware-only and intentionally left out: LINE/PHONO inputs, booth output, and headphone cueing — which needs a second audio output.)

**Interactive waveforms & cues:**
- **Scrub** — drag a waveform to pull the track back and forth (you hear it, 1:1 with the pixels on screen). **Click** to needle-drop to a spot.
- **Hot cues** — `Shift`-click a waveform to drop a cue, click a cue flag to snap to it, double-click it to clear. Or use keys `1`–`4` (Deck A) / `6`–`9` (Deck B) to set/recall, `Shift`+key to clear. Cues survive scratching so you can return to an exact point.
- **Zoom** — the `＋` / `－` buttons above each waveform.

Waveforms render through an `OffscreenCanvas` worker when the browser supports it,
with a main-thread canvas fallback for older browsers.

**Customize controls (Settings):** The **⚙** button opens a configuration panel to remap every key (transport, cues, crossfader, hot cues, sampler pads), learn Web MIDI controller assignments, and edit trackpad gestures (modifier keys for arming/slamming). You can also adjust scratch/crossfade sensitivity, invert the scratch direction, select the **Crossfader Curve** (Equal Power, Linear Blend, or Sharp Cut for scratching), toggle **Hamster Mode** (which reverses the crossfader direction), and enable/disable haptic vibration on supported mobile devices. Click a key button, press the new key (Esc cancels); click a MIDI action and move a controller to bind it. Settings persist automatically in `localStorage`.

**Platters:** Platters spin in proportion to the playhead and reverse direction during scratching. A fixed white tick at 12 o'clock and a rotating marker/sticker provide a visual vinyl reference.
- **Play / pause** — `Q` (Deck A), `P` (Deck B), or the transport buttons.
- **Cue** — `W` / `O` jump to the cue point; `E` / `I` set it (or the CUE / SET buttons).
- **EQ** — drag the HI / MID / LO knobs (double-click to reset to neutral / kill toward the bottom).
- **Volume & tempo** — the channel faders. Tempo is ±8% (vinyl-style: pitch moves with speed).
- **Load a track** — drop an audio file onto a deck, click **Load file**, or paste a direct audio URL via the **link** button.

## Practice mode

The **🎓 Practice** button (top bar) opens a set of guided, interactive lessons that
teach real DJ / turntablist technique. Each lesson loads a synthesized practice beat,
shows a step-by-step coach card, **highlights the exact control to use**, and detects
when you've met the objective before moving on (or waits for "Got it" on teaching
steps). The coach card is draggable and minimizable.

Curriculum:

- **Foundations** — decks & the platter, cue points / hot cues.
- **Beatmatching** — matching tempo with the pitch fader (with a live BPM readout),
  nudging two beats into phase.
- **Timing** — metronome drills that score every move against an audible click: an
  on-beat scratch drill and an on-beat crossfader-cut drill. A pulsing dot shows the
  beat, and each hit is graded live (🎯 Perfect / 🟡 slightly early-late / 🔴 off);
  only on-beat hits count toward the objective.
- **Mixing** — the crossfade blend, EQ bass-swapping for clean transitions, phrasing.
- **Scratching** — baby scratch → forward/cut → tear → transformer → flare, plus a
  **scribble & chirp** speed/coordination drill, each with the move's mechanics and a
  note on who pioneered it.
- **Beat juggling** — rebuild a break live across two decks with cues and the crossfader
  (à la Steve Dee / the X-Ecutioners).
- **Culture** — a short tour of turntablism history (Kool Herc's breaks, Grand Wizzard
  Theodore inventing the scratch in 1975, Grandmaster Flash, GrandMixer DXT, DJ QBert).
- **🔥 Freestyle** — a scored 30-second routine. Go off on both decks against a steady
  pulse (a beat indicator shows the grid). The app tracks your scratches, cuts,
  **on-beat timing**, EQ/cue/tempo use and transitions, then gives you:
  - a **score /100**, a **rank** (Bedroom DJ → Block Party → Club Ready → Battle DJ →
    Turntable Wizard) and a 6-category breakdown (incl. a **Timing** score for how well
    your moves land on the beat);
  - a **local leaderboard** of your top 5 scores (saved in the browser, "NEW BEST!" flag);
  - **record & playback** — your routine's audio is captured so you can **hear yourself
    back** and **save** it as a file.

Technique and history were researched from turntablism sources including
[BPM Music's scratch guide](https://blog.bpmmusic.io/news/10-basic-scratch-dj-techniques-w-video-examples/),
[Mixcloud's beatmatching guide](https://www.mixcloud.com/blog/2025/09/02/a-guide-to-beatmatching/),
[DJ TechTools on EQ mixing](https://djtechtools.com/2012/03/11/eq-critical-dj-techniques-theory/),
and [Pioneer DJ's turntablism history](https://blog.pioneerdj.com/dj-culture/the-most-important-events-in-turntablism-history/).

## How scratching works

Standard Web Audio buffer sources can only play forward at a positive rate, so they
can't scratch. Sxratch ships a custom `AudioWorklet`
([`js/scratch-processor.js`](js/scratch-processor.js)) that keeps its own
floating-point playhead and reads the track with **4-point Catmull-Rom (cubic)
interpolation** at a hand-controlled, signed, variable rate — so it can fly backward,
stall, and catch back up like a real turntable, smoothly even at extreme speeds.
Pointer velocity drives the platter while you touch it; a simulated motor eases it back
to speed when you let go.

When the page is **cross-origin isolated** (the server sends the COOP/COEP headers),
hand motion reaches the audio thread over a **`SharedArrayBuffer`** the worklet polls
every render block — lower latency and no message-queue jitter — falling back to
`postMessage` otherwise. On touchscreens, scratch input also reads **coalesced pointer
samples** (120–240 Hz) for finer resolution. The summed master bus runs through
`js/limiter-processor.js`, a look-ahead AudioWorklet limiter (with a compressor fallback
if the module can't load).

## About streaming services

Spotify / Apple Music / YouTube / SoundCloud streams are DRM-protected and don't expose
raw PCM to the browser, so they can't be scratched (and scraping them would violate
their terms). Sxratch instead supports **file upload**, **drag-and-drop**, and **direct
audio URLs** (any host that allows cross-origin requests). Use your own files or
royalty-free/Creative-Commons sources.

## Project layout

```
index.html                  markup + app layout
css/tokens.css              shared colours, spacing and typography tokens
css/styles.css              shared shell, top bar and responsive foundations
css/decks.css               SXRATCH deck, mixer and practice UI
css/daw.css                 PAD transport, timeline, editors, devices and mixer
js/app.js                   bootstrap, UI wiring, recording, sampler, settings
js/audio-engine.js          AudioContext, decks, EQ/filter/FX, crossfade, master bus
js/scratch-processor.js     AudioWorklet variable-rate scratch engine
js/limiter-processor.js     AudioWorklet look-ahead master limiter
js/input.js                 scratch pads, faders, knobs, trackpad gestures, keyboard
js/waveform.js              waveform model, peak computation, canvas/worker bridge
js/waveform-draw.js         shared waveform drawing routines
js/waveform-worker.js       OffscreenCanvas waveform renderer
js/practice.js              guided lessons, scoring, freestyle recorder hooks
js/daw.js                   PAD UI, song model, editing, persistence and exports
js/daw-engine.js            realtime scheduler, recording graph and offline bounce
js/daw-model.js             pure region, timing, clipboard and automation helpers
js/daw-guidance.js          Studio shortcut registry and resumable guided tour
js/idb-store.js             PAD audio clips, current song and recovery checkpoints
js/synth.js                 built-in synth/drum voices and shared mix DSP
js/store.js                 versioned localStorage envelopes and migrations
js/wav.js                   AudioBuffer-to-WAV encoding
js/theory.js                shared DSP/music helpers
js/presets.js               synthetic deck presets
js/bpm.js                   onset-envelope BPM detection for loaded tracks
js/midiexport.js            Standard MIDI File writer for PAD regions/markers
js/midi.js                  Web MIDI input + default controller map
js/haptics.js               vibration helpers for mobile feedback
js/ui.js                    display + toast helpers
server.js                   zero-dependency static server for source or dist/
build.js                    esbuild production build into dist/
manifest.webmanifest        PWA manifest and install icons
sw.js                       network-first service worker with offline shell cache
twa-manifest.json           Bubblewrap/Trusted Web Activity config
.well-known/assetlinks.json Android Digital Asset Links placeholder
scripts/make-icons.js       icon PNG generation from icon.svg
icon.svg / icon-*.png       app icons (SVG source + generated 192/512 PNGs)
test/*.test.js              Node tests for DSP, DAW models/engine and persistence
jsconfig.json               editor type-checking (checkJs) config
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for how the threads, audio graph and modules fit
together, and [TWA.md](TWA.md) for packaging the PWA as an Android app.
