// Sxratch — main entry. Wires DOM + input to the audio engine.

import { AudioEngine, Sampler } from "./audio-engine.js";
import { Waveform } from "./waveform.js";
import { UI } from "./ui.js";
import { attachScratchPad, attachKnob, attachTrackpadGestures, attachWaveformScrub, attachFader } from "./input.js";
import { PracticeCoach, LESSONS, makeBeat } from "./practice.js";
import { DAW } from "./daw.js";
import { generateScratchPreset, generateLaserPreset } from "./presets.js";
import { MidiInput, DEFAULT_MIDI_MAP } from "./midi.js";
import { haptic, setHapticsEnabled, hapticsSupported } from "./haptics.js";
import { detectBPM } from "./bpm.js";
import { createMixRecorder } from "./recorder.js";
import { bufferToWav } from "./wav.js";
import { readVersioned, writeVersioned } from "./store.js";
import { createTapTempo } from "./taptempo.js";
import { initTheme, applyTheme, cycleTheme, themeMode, themeColors, onThemeChange, THEME_MODES } from "./theme.js";

let coach = null;
let sampler = null;

const engine = new AudioEngine();
const ui = new UI(engine);
const analysers = {};
const discs = {};                               // rotating platter elements
const vizCache = {};                            // per-deck { canvas, ctx, buf } for the FFT visualizer (reused each frame)
const rot = { A: { pos: 0, rate: 0, t: 0 }, B: { pos: 0, rate: 0, t: 0 } };
const HOT_CUE_COUNT = 8;
const hot = { A: Array(HOT_CUE_COUNT).fill(null), B: Array(HOT_CUE_COUNT).fill(null) };
let mappingSource = null;                       // { deckId, start, end } for sampler region mapping

// Live mirrors of the CSS tokens — mutated in place on every theme change so
// the ~20 call sites that read them keep working. Seeded with the dark values
// so the first frame before `initTheme`'s rAF is still correct on dark.
// KEEP THE SEEDS IN SYNC with tokens.css: --sx-deck-a/-b and --sx-cue-1..8.
const DECK_COLORS = { A: "#48ddd3", B: "#ff6175" };
const CUE_COLORS = ["#ffd23f", "#48ddd3", "#ff6175", "#6c7bff", "#f89b29", "#79e66b", "#b16cff", "#6ad7ff"];
const DEG_PER_SEC = 200;                          // 33⅓ RPM platter spin

// BPM truthfulness: only display a number when we actually know it (metadata
// from a preset / PAD render, or a confident detection) — otherwise "--".
const bpmKnown = { A: false, B: false };
const bpmDetectToken = { A: 0, B: 0 };            // invalidates stale async detections
const arts = {};                                  // per-deck album-art tiles (real thumbnails)

// Live master metering (topbar), created in setupTopbarMaster().
let masterVuEl = null, masterAnalyser = null, masterBuf = null, masterPeak = 0;

const demoChips = {};                             // per-deck "load a demo" chips on empty decks
const knobArcs = [];                              // { svg, band, deck } — recoloured on theme change

// Monochrome line icons (inline SVG — crisp at any DPI, no emoji tofu).
const ICONS = {
  link: '<svg viewBox="0 0 24 24"><path d="M10.6 13.4a4 4 0 0 0 5.6 0l3.2-3.2a4 4 0 1 0-5.6-5.6l-1.4 1.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M13.4 10.6a4 4 0 0 0-5.6 0l-3.2 3.2a4 4 0 1 0 5.6 5.6l1.4-1.4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  zoomOut: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.6 15.6 21 21M7.5 10.5h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  zoomIn: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.6 15.6 21 21M10.5 7.5v6M7.5 10.5h6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  folder: '<svg viewBox="0 0 24 24"><path d="M3 7a2 2 0 0 1 2-2h4.2l1.8 2H19a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>',
  grid: '<svg viewBox="0 0 24 24"><path d="M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z" fill="currentColor"/></svg>',
  phones: '<svg viewBox="0 0 24 24"><path d="M4 14a8 8 0 0 1 16 0" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="3" y="13.5" width="4.2" height="7" rx="1.6" fill="currentColor"/><rect x="16.8" y="13.5" width="4.2" height="7" rx="1.6" fill="currentColor"/></svg>',
  gear: '<svg viewBox="0 0 24 24"><path d="M12 15.2A3.2 3.2 0 1 0 12 8.8a3.2 3.2 0 0 0 0 6.4zm7.4-3.2c0-.5 0-.9-.1-1.3l2.1-1.6-2-3.4-2.4 1a7.6 7.6 0 0 0-2.2-1.3L14.4 3H9.6l-.4 2.4a7.6 7.6 0 0 0-2.2 1.3l-2.4-1-2 3.4L4.7 10.7a8 8 0 0 0 0 2.6l-2.1 1.6 2 3.4 2.4-1a7.6 7.6 0 0 0 2.2 1.3l.4 2.4h4.8l.4-2.4a7.6 7.6 0 0 0 2.2-1.3l2.4 1 2-3.4-2.1-1.6c.1-.4.1-.8.1-1.3z" fill="currentColor"/></svg>',
};
function icon(name) {
  const s = document.createElement("span");
  s.className = "ic";
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = ICONS[name] || "";
  return s;
}
const label = (text, cls = "") => {
  const s = document.createElement("span");
  if (cls) s.className = cls;
  s.textContent = text;
  return s;
};

// Recompose the legacy document bands into one controller chassis. Moving the
// existing nodes keeps every event target, canvas, and audio control intact.
composeDeckConsole();
styleTopbarChrome();

/** Swap the topbar's emoji for line icons + the reference labels. */
function styleTopbarChrome() {
  const drawer = document.getElementById("drawer-btn");
  if (drawer) { drawer.replaceChildren(icon("grid"), label("PADS + FX")); }
  const practice = document.getElementById("practice-btn");
  if (practice) { practice.replaceChildren(icon("phones"), label("PRACTICE")); }
  const rec = document.getElementById("record-btn");
  if (rec) {
    rec.replaceChildren();
    const dot = document.createElement("i");
    dot.className = "rec-dot";
    dot.setAttribute("aria-hidden", "true");
    rec.append(dot, label("REC", "rec-label"));
  }
  const settings = document.getElementById("settings-btn");
  if (settings) { settings.replaceChildren(icon("gear")); }
}

function composeDeckConsole() {
  const consoleEl = document.getElementById("console");
  if (!consoleEl || consoleEl.querySelector(".controller-shell")) return;

  const decksTop = consoleEl.querySelector(".decks-top");
  const scratchZone = consoleEl.querySelector(".scratch-zone");
  const transportRow = consoleEl.querySelector(".transport-row");
  const mixer = consoleEl.querySelector(".mixer");
  if (!decksTop || !scratchZone || !transportRow || !mixer) return;

  const shell = document.createElement("section");
  shell.className = "controller-shell";
  shell.setAttribute("aria-label", "Sxratch dual-deck controller");

  const center = document.createElement("section");
  center.className = "controller-center";
  center.setAttribute("aria-label", "Waveforms and mixer");

  const waveConsole = document.createElement("section");
  waveConsole.className = "wave-console";
  waveConsole.setAttribute("aria-label", "Deck waveform controls");

  const centerToolbar = document.createElement("div");
  centerToolbar.className = "wave-toolbar";
  centerToolbar.dataset.deck = "A";

  const waveStage = document.createElement("div");
  waveStage.className = "wave-stage";
  waveStage.setAttribute("aria-label", "Stacked deck waveforms");

  const loopStrip = document.createElement("div");
  loopStrip.className = "center-loop-strip";
  loopStrip.dataset.deck = "A";

  // Explicit A | B switch: the centre toolbar + loop strip are shared between
  // decks, so which deck they control must always be visible and tappable.
  const deckSwitch = document.createElement("div");
  deckSwitch.className = "deck-switch";
  deckSwitch.setAttribute("role", "group");
  deckSwitch.setAttribute("aria-label", "Toolbar deck");
  const deckPicks = {};
  for (const id of ["A", "B"]) {
    const b = document.createElement("button");
    b.className = "deck-pick";
    b.dataset.deck = id;
    b.type = "button";
    b.textContent = id;
    b.title = `Point the toolbar & loop controls at Deck ${id}`;
    deckSwitch.append(b);
    deckPicks[id] = b;
  }

  const activeDeckControls = [];
  let loopLabelEl = null;
  const setActiveDeck = (deckId) => {
    shell.dataset.activeDeck = deckId;
    centerToolbar.dataset.deck = deckId;
    loopStrip.dataset.deck = deckId;
    if (loopLabelEl) loopLabelEl.textContent = `LOOP ${deckId}`;
    for (const id of ["A", "B"]) {
      deckPicks[id].classList.toggle("active", id === deckId);
      deckPicks[id].setAttribute("aria-pressed", id === deckId ? "true" : "false");
    }
    // Brief flash so auto-follow (touch a deck → toolbar retargets) is noticed.
    const pick = deckPicks[deckId];
    pick.classList.remove("flash");
    void pick.offsetWidth;
    pick.classList.add("flash");
    activeDeckControls.forEach((el) => {
      el.dataset.deck = deckId;
      if (el.classList.contains("preset-select")) {
        el.setAttribute("aria-label", `Preset loader for Deck ${deckId}`);
      }
    });
    Object.values(sides).forEach((side) => {
      if (side) side.classList.toggle("active", side.dataset.deck === deckId);
    });
  };
  deckPicks.A.addEventListener("click", () => setActiveDeck("A"));
  deckPicks.B.addEventListener("click", () => setActiveDeck("B"));
  centerToolbar.append(deckSwitch);

  const sides = {};
  for (const id of ["A", "B"]) {
    const side = document.createElement("section");
    side.className = `deck-side deck-${id.toLowerCase()}`;
    side.dataset.deck = id;
    side.setAttribute("aria-label", `Deck ${id}`);

    const meta = decksTop.querySelector(`.deck-meta[data-deck="${id}"]`);
    const wave = meta?.querySelector(".waveform");
    const metaLine = meta?.querySelector(".meta-line");
    const title = meta?.querySelector(".title");
    const time = meta?.querySelector(".time");
    const badge = meta?.querySelector(".badge");
    const hotcues = meta?.querySelector(".hotcues");
    const loadRow = meta?.querySelector(".load-row");
    const loopRow = meta?.querySelector(".loop-row");
    const rail = scratchZone.querySelector(`.deck-rail[data-deck="${id}"]`);
    const jog = scratchZone.querySelector(`.jog-pad[data-deck="${id}"]`);
    const transport = transportRow.querySelector(`.transport[data-deck="${id}"]`);
    if (!meta || !wave || !metaLine || !title || !time || !hotcues || !loadRow || !loopRow || !rail || !jog || !transport) continue;

    const deckLabel = document.createElement("div");
    deckLabel.className = "deck-heading";
    deckLabel.innerHTML = `<span>DECK ${id}</span>`;

    const trackCard = document.createElement("div");
    trackCard.className = "track-card";

    const art = document.createElement("div");
    art.className = "album-art";
    art.setAttribute("aria-hidden", "true");
    arts[id] = art;

    const trackInfo = document.createElement("div");
    trackInfo.className = "track-info";

    const trackStats = document.createElement("div");
    trackStats.className = "track-stats";
    // Live BPM readout — "--" until the value is actually known (preset / PAD
    // metadata or a confident detection). No fake numbers. Interactive:
    // click repeatedly to TAP the tempo in, double-click to type one.
    const bpm = document.createElement("span");
    bpm.className = "track-bpm";
    bpm.textContent = "--";
    bpm.title = "Effective BPM · click to tap tempo · double-click to type";
    ui.bpmEl[id] = bpm;
    attachBpmEntry(bpm, id);
    const bpmUnit = document.createElement("span");
    bpmUnit.className = "track-bpm-unit";
    bpmUnit.textContent = "BPM";
    trackStats.append(bpm, bpmUnit, time);

    if (badge) badge.remove();
    metaLine.remove();
    trackInfo.append(title, trackStats);

    const loadBtn = loadRow.querySelector(".load-btn");
    const fileInput = loadRow.querySelector(".file-input");
    if (loadBtn) {
      loadBtn.classList.add("load-tile");
      loadBtn.replaceChildren(icon("folder"), label("LOAD"));
    }
    trackCard.append(art, trackInfo);
    if (loadBtn) trackCard.append(loadBtn);
    if (fileInput) trackCard.append(fileInput);

    const hotBlock = document.createElement("div");
    hotBlock.className = "hotcue-block";
    const hotLabel = document.createElement("span");
    hotLabel.className = "section-label";
    hotLabel.textContent = "HOT CUES";
    hotBlock.append(hotLabel, hotcues);

    meta.replaceChildren(deckLabel, trackCard, hotBlock);

    if (id === "A") {
      const urlBtn = loadRow.querySelector(".url-btn");
      const dblBtn = loadRow.querySelector(".dbl-btn");
      const preset = loadRow.querySelector(".preset-select");
      const zoomOut = loadRow.querySelector('.zoom-btn[data-dir="out"]');
      const zoomIn = loadRow.querySelector('.zoom-btn[data-dir="in"]');
      if (urlBtn) {
        urlBtn.replaceChildren(icon("link"), label("LINK"));
        centerToolbar.append(urlBtn);
        activeDeckControls.push(urlBtn);
      }
      if (dblBtn) {
        dblBtn.textContent = "DBL";
        centerToolbar.append(dblBtn);
        activeDeckControls.push(dblBtn);
      }
      if (preset) {
        const placeholder = preset.querySelector('option[value=""]');
        if (placeholder) placeholder.textContent = "Default";
        const presetWrap = document.createElement("label");
        presetWrap.className = "preset-wrap";
        presetWrap.innerHTML = `<span>PRESETS</span>`;
        presetWrap.append(preset);
        centerToolbar.append(presetWrap);
        activeDeckControls.push(preset);
      }
      const zoomGroup = document.createElement("div");
      zoomGroup.className = "zoom-group";
      if (zoomOut) {
        zoomOut.replaceChildren(icon("zoomOut"));
        zoomOut.setAttribute("aria-label", "Zoom waveform out");
        zoomGroup.append(zoomOut);
        activeDeckControls.push(zoomOut);
      }
      if (zoomIn) {
        zoomIn.replaceChildren(icon("zoomIn"));
        zoomIn.setAttribute("aria-label", "Zoom waveform in");
        zoomGroup.append(zoomIn);
        activeDeckControls.push(zoomIn);
      }
      centerToolbar.append(zoomGroup);

      loopStrip.append(loopRow);
      loopLabelEl = loopRow.querySelector(".loop-label");
      const toPadBtn = loopRow.querySelector(".loop-to-pad");
      if (toPadBtn) toPadBtn.textContent = "TO PAD";
      activeDeckControls.push(...loopRow.querySelectorAll("[data-deck]"));
    } else {
      loadRow.remove();
      loopRow.remove();
    }

    const waveLane = document.createElement("div");
    waveLane.className = "wave-lane";
    waveLane.dataset.deck = id;
    const laneLabel = document.createElement("span");
    laneLabel.className = "wave-lane-label";
    laneLabel.textContent = id;
    laneLabel.setAttribute("aria-hidden", "true");
    // Empty-deck demo chip — one tap to sound (wired in setup(), hidden on load).
    const demo = document.createElement("button");
    demo.className = "demo-chip";
    demo.type = "button";
    demo.dataset.deck = id;
    demo.textContent = id === "A" ? "▶ LOAD DEMO BEAT" : "▶ LOAD SCRATCH SOUND";
    demoChips[id] = demo;
    waveLane.append(laneLabel, wave, demo);
    waveStage.append(waveLane);

    const deckBody = document.createElement("div");
    deckBody.className = "deck-body";
    deckBody.append(rail, jog);

    transport.querySelector(".tp-start")?.replaceChildren(document.createTextNode("● START"));
    transport.querySelector(".tp-rew")?.replaceChildren(document.createTextNode("◀◀ REW"));
    transport.querySelector(".tp-ff")?.replaceChildren(document.createTextNode("▶▶ FF"));
    transport.querySelector(".cue-btn")?.replaceChildren(document.createTextNode("CUE"));
    transport.querySelector(".set-btn")?.replaceChildren(document.createTextNode("SET"));
    transport.querySelector(".sync-btn")?.replaceChildren(document.createTextNode("SYNC"));
    transport.querySelector(".play-btn")?.replaceChildren(document.createTextNode("▶ PLAY"));

    side.append(meta, deckBody, transport);
    side.addEventListener("pointerdown", () => setActiveDeck(id), { passive: true });
    side.addEventListener("focusin", () => setActiveDeck(id));
    sides[id] = side;
  }

  const transportCenter = transportRow.querySelector(".transport-center");
  const crossfadeCol = mixer.querySelector(".crossfade-col");
  if (transportCenter && crossfadeCol) {
    const crossfader = crossfadeCol.querySelector(".crossfader-wrap");
    crossfadeCol.insertBefore(transportCenter, crossfader || null);
  }

  const centerFaders = document.createElement("div");
  centerFaders.className = "center-faders";
  const vfaderA = mixer.querySelector('.channel[data-deck="A"] .vfader');
  const vfaderB = mixer.querySelector('.channel[data-deck="B"] .vfader');
  if (vfaderA && vfaderB && crossfadeCol) {
    centerFaders.append(vfaderA, vfaderB);
    const crossfader = crossfadeCol.querySelector(".crossfader-wrap");
    crossfadeCol.insertBefore(centerFaders, crossfader || null);
  }

  // Centre dB meters (reference layout): lift each channel's VU out of its
  // fader row and pair them between the EQ columns, flanked by dB scales.
  // The scale labels match the meter's actual dB mapping (see frameLoop).
  const meterBridge = document.createElement("div");
  meterBridge.className = "meter-bridge";
  meterBridge.setAttribute("aria-hidden", "true");
  const mkScale = (side) => {
    const sc = document.createElement("div");
    sc.className = "meter-scale " + side;
    ["0", "-6", "-12", "-18", "-24", "-30"].forEach((t) => sc.append(label(t)));
    return sc;
  };
  const vuA = document.getElementById("vu-A");
  const vuB = document.getElementById("vu-B");
  if (vuA && vuB && crossfadeCol) {
    meterBridge.append(mkScale("l"), vuA, vuB, mkScale("r"));
    crossfadeCol.insertBefore(meterBridge, transportCenter && transportCenter.parentElement === crossfadeCol ? transportCenter : crossfadeCol.firstChild);
  }

  // Truthful ruler chrome: the canvases draw real beat/bar grids, so the
  // stage can carry the "Bars" caption and one shared centre playhead.
  const barsCaption = document.createElement("span");
  barsCaption.className = "wave-caption";
  barsCaption.textContent = "Bars";
  barsCaption.title = "Bar ruler — numbers appear when the beat grid is anchored (presets & PAD renders)";
  const stagePlayhead = document.createElement("div");
  stagePlayhead.className = "stage-playhead";
  stagePlayhead.setAttribute("aria-hidden", "true");
  waveStage.append(barsCaption, stagePlayhead);

  waveConsole.append(centerToolbar, waveStage, loopStrip);
  center.append(waveConsole, mixer);
  shell.append(sides.A, center, sides.B);
  consoleEl.prepend(shell);
  setActiveDeck("A");

  decksTop.remove();
  scratchZone.remove();
  transportRow.remove();
}

// ---------- Configurable controls (persisted to localStorage) ----------
const DEFAULT_KEYS = {
  playA: "KeyQ", playB: "KeyP",
  cueA: "KeyW", cueB: "KeyO",
  setCueA: "KeyE", setCueB: "KeyI",
  crossLeft: "ArrowLeft", crossRight: "ArrowRight", crossCenter: "ArrowDown",
  hotA1: "Digit1", hotA2: "Digit2", hotA3: "Digit3", hotA4: "Digit4",
  hotB1: "Digit6", hotB2: "Digit7", hotB3: "Digit8", hotB4: "Digit9",
  // All 8 chips have keys (5–8 used to be pointer-only): bottom row, split
  // left hand → Deck A and right hand → Deck B like the digit rows above.
  hotA5: "KeyZ", hotA6: "KeyX", hotA7: "KeyC", hotA8: "KeyV",
  hotB5: "KeyB", hotB6: "KeyN", hotB7: "KeyM", hotB8: "Comma",
  samp1: "KeyA", samp2: "KeyS", samp3: "KeyD", samp4: "KeyF",
  samp5: "KeyG", samp6: "KeyH", samp7: "KeyJ", samp8: "KeyK",
  loopA: "KeyR", loopB: "KeyU",
  playBoth: "Space", syncA: "KeyT", syncB: "KeyY",
};
const DEFAULT_GESTURES = {
  armA: "ControlRight", armB: "ControlLeft",
  slamAMod: "AltRight", slamBMod: "ShiftLeft", // left slam = Left Ctrl + Left Shift
  invertScratch: false,
  scratchSensitivity: 0.0016,
  crossfadeSensitivity: 0.0042,
  idleMs: 90,
  crossfadeCurve: "power",
  hamsterMode: false,
};
// Config schema version (legacy raw saves are v0 — same shape, identity step).
// v1 → v2 adds `theme`; absent means "auto", so the step is additive.
// Declared BEFORE the loadConfig() call below: module-level `const config =
// loadConfig()` executes immediately, so these must already be initialized.
const CONFIG_SCHEMA_V = 2;
const CONFIG_MIGRATIONS = [(c) => c, (c) => ({ ...c, theme: c.theme ?? "auto" })];

const config = loadConfig();
let keyMap = {}; // key code -> action name
const tempoFaders = {}; // { A, B } custom fader handles, for SYNC
let midi = null;                 // MidiInput instance
let midiLearn = null;            // action id currently waiting to bind a CC
const midiTargets = {};          // action id -> (value 0..1) => void  (set on-screen control)
const midiJogState = { A: { active: false, timer: null }, B: { active: false, timer: null } };

function loadConfig() {
  const saved = readVersioned("sxratch.config", CONFIG_SCHEMA_V, CONFIG_MIGRATIONS) || {};
  return {
    keys: { ...DEFAULT_KEYS, ...(saved.keys || {}) },
    gestures: { ...DEFAULT_GESTURES, ...(saved.gestures || {}) },
    midi: {
      enabled: saved.midi?.enabled ?? false,
      map: { ...DEFAULT_MIDI_MAP, ...(saved.midi?.map || {}) },
    },
    haptics: saved.haptics ?? true,
    theme: THEME_MODES.includes(saved.theme) ? saved.theme : "auto",
  };
}
function saveConfig() {
  writeVersioned("sxratch.config", CONFIG_SCHEMA_V, config);
}
function rebuildKeyMap() {
  keyMap = {};
  for (const [action, code] of Object.entries(config.keys)) keyMap[code] = action;
}

// ---------- Theme ----------
// Applied at module scope (not in setup()) so the start overlay is themed too.
// The inline <head> script has already set data-theme, so this only agrees
// with it and starts the OS-preference listener.
const THEME_LABEL = { auto: "follow system", light: "light", dark: "dark" };
const THEME_GLYPH = { auto: "◐", light: "☀", dark: "☾" };

onThemeChange((colors) => {
  DECK_COLORS.A = colors["deck-a"];
  DECK_COLORS.B = colors["deck-b"];
  colors.cues.forEach((c, i) => { CUE_COLORS[i] = c; });

  const waveInk = {
    body: colors["wave-body"],
    gridBeat: colors["wave-grid-beat"],
    gridBar: colors["wave-grid-bar"],
    label: colors["wave-label"],
    centre: colors["wave-centre"],
    playhead: colors["wave-playhead"],
    cueInk: colors["wave-cue-ink"],
    cueFallback: colors.cues[0],
  };
  for (const id of ["A", "B"]) {
    ui.waves?.[id]?.setColors({ color: DECK_COLORS[id], ink: waveInk });
    if (arts[id]) drawArtThumb(id);
    // Cue chip swatches are inline styles, so they need repainting too.
    document.querySelectorAll(`.hotcues[data-deck="${id}"] .hotcue-chip.set`).forEach((chip, i) => {
      chip.style.background = CUE_COLORS[i % CUE_COLORS.length];
    });
  }
  knobArcs.forEach(({ svg, band, deck }) => {
    const path = svg.querySelector("path");
    if (path) path.setAttribute("stroke", band === "filter" ? colors.accent : DECK_COLORS[deck]);
  });
  const btn = document.getElementById("theme-btn");
  if (btn) {
    const m = themeMode();
    btn.textContent = THEME_GLYPH[m];
    btn.setAttribute("aria-label", `Appearance: ${THEME_LABEL[m]}`);
    btn.title = `Appearance: ${THEME_LABEL[m]} — click to change`;
  }
});
initTheme(config.theme);

function setTheme(mode) {
  config.theme = applyTheme(mode);
  saveConfig();
  return config.theme;
}

document.getElementById("theme-btn")?.addEventListener("click", () => {
  const m = cycleTheme();
  config.theme = m;
  saveConfig();
  const sel = document.getElementById("theme-select");
  if (sel) sel.value = m;
});

// ---------- Install (PWA) ----------
// The app has been installable for a while, but nothing SAID so — the browser
// omnibox hint is the only affordance Chrome gives and iOS gives none at all.
// The topbar button appears when installing is actually possible: Chrome et
// al. fire beforeinstallprompt; iOS Safari never does, so there the button
// opens Add-to-Home-Screen instructions instead.
{
  const btn = document.getElementById("install-btn");
  const standalone = window.matchMedia?.("(display-mode: standalone)").matches
    || navigator.standalone === true;   // iOS's non-standard spelling
  let deferredPrompt = null;

  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();                 // no unsolicited mini-infobar
    deferredPrompt = e;
    if (btn && !standalone) btn.hidden = false;
  });
  window.addEventListener("appinstalled", () => { if (btn) btn.hidden = true; deferredPrompt = null; });

  const isIOS = /iphone|ipad|ipod/i.test(navigator.userAgent)
    || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1); // iPadOS masquerades as Mac
  if (btn && isIOS && !standalone) btn.hidden = false;

  btn?.addEventListener("click", async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === "accepted") btn.hidden = true;
      deferredPrompt = null;            // a prompt object is single-use
      return;
    }
    // iOS: installing is a manual gesture Safari owns — show the steps.
    // Class .dialog so the app-wide focus trap + Esc handling apply.
    let dlg = document.getElementById("install-dialog");
    if (!dlg) {
      dlg = document.createElement("div");
      dlg.className = "dialog";
      dlg.id = "install-dialog";
      dlg.innerHTML = `
        <div class="dialog-card">
          <h3>Install Sxratch</h3>
          <p class="muted">Add it to your Home Screen and it runs full-screen,
            works offline, and keeps your songs on the device:</p>
          <ul class="help-list">
            <li>Tap the <b>Share</b> button in Safari's toolbar</li>
            <li>Scroll down and tap <b>Add to Home Screen</b></li>
            <li>Tap <b>Add</b></li>
          </ul>
          <div class="dialog-actions">
            <button class="btn primary" id="install-close">Got it</button>
          </div>
        </div>`;
      document.body.appendChild(dlg);
      dlg.querySelector("#install-close").addEventListener("click", () => { dlg.hidden = true; });
    }
    dlg.hidden = false;
    dlg.querySelector("#install-close").focus();
  });
}

// ---------- Boot (needs a user gesture for audio) ----------
const overlay = document.getElementById("start-overlay");
let booting = false, booted = false;
document.getElementById("start-btn").addEventListener("click", async () => {
  // One-shot: a double-click (or a second click racing engine.init) would run
  // setup() twice, and the second `new Waveform` throws — the canvas has
  // already transferred its control to the render worker.
  if (booting || booted) return;
  booting = true;
  try {
    await engine.init();
    await engine.resume();
    engine.crossfadeCurve = config.gestures.crossfadeCurve ?? "power";
    engine.hamster = config.gestures.hamsterMode ?? false;
    setup();
    booted = true;
    overlay.style.display = "none";
  } catch (err) {
    console.error(err);
    // No alert(): render the failure into the start card so the user gets a
    // styled, actionable message (and a Retry) instead of a browser popup.
    const card = overlay.querySelector(".start-card");
    let msg = card && card.querySelector(".start-error");
    if (card && !msg) {
      msg = document.createElement("p");
      msg.className = "start-error";
      card.insertBefore(msg, document.getElementById("start-btn"));
    }
    if (msg) {
      msg.textContent = "Couldn't start audio — " +
        (err && err.message ? err.message : "this browser may not support AudioWorklet.");
    }
    document.getElementById("start-btn").textContent = "Retry";
    booting = false; // allow Retry
  }
});

function setup() {
  // Waveforms
  for (const id of ["A", "B"]) {
    const canvas = document.getElementById(`wave-${id}`);
    const wave = new Waveform(canvas, { color: DECK_COLORS[id] });
    ui.setWaveform(id, wave);

    const deck = engine.decks[id];
    discs[id] = document.getElementById(`disc-${id}`);
    deck.onPosition = (pos, playing, rate, loop) => {
      ui.updatePosition(id, pos);
      ui.setPlaying(id, playing);
      const r = rot[id];
      r.pos = pos; r.rate = rate; r.t = performance.now();
      ui.waves[id].setLoop(loop);
      const autoBtn = document.querySelector(`.loop-auto[data-deck="${id}"]`);
      if (autoBtn) autoBtn.classList.toggle("active", !!(loop && loop.active));
    };

    // Per-channel VU analyser (taps post-volume signal)
    const an = engine.ctx.createAnalyser();
    an.fftSize = 256;
    deck.volume.connect(an);
    analysers[id] = { node: an, buf: new Float32Array(an.fftSize), el: document.getElementById(`vu-${id}`) };

    // Scratch pad (mouse / touch press-drag)
    const padEl = document.getElementById(`pad-${id}`);
    attachScratchPad(padEl, deck, { sensitivity: 0.0024 });

    // Keyboard access to the platter: focus it and nudge with ← →.
    padEl.tabIndex = 0;
    padEl.setAttribute("role", "slider");
    padEl.setAttribute("aria-label", `Deck ${id} platter — drag to scratch, arrow keys nudge`);
    padEl.setAttribute("aria-valuemin", "0");
    padEl.setAttribute("aria-valuemax", "1");
    padEl.addEventListener("keydown", (e) => {
      const dir = e.code === "ArrowRight" ? 1 : e.code === "ArrowLeft" ? -1 : 0;
      if (!dir) return;
      e.preventDefault();
      e.stopPropagation();
      deck.touchStart();
      deck.jog(dir * (e.shiftKey ? 6 : 2.5));
      setTimeout(() => deck.touchEnd(), 70);
    });

    // Interactive waveform: scrub / seek / hot cues
    attachWaveformScrub(canvas, deck, wave, {
      onSeek: (p) => deck.seek(p),
      onSetCue: (p) => setCueSlot(id, hot[id].indexOf(null) === -1 ? 0 : hot[id].indexOf(null), p),
      onClearCue: (slot) => clearCue(id, slot),
    });
  }

  // Device-appropriate scratch hint.
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  document.querySelectorAll(".pad-hint").forEach((h) => {
    h.textContent = coarse ? "drag ← → to scratch" : "hold Ctrl + one finger ↕ scratch · two fingers ↔ crossfade";
  });

  setupLoading();
  setupTransport();
  setupMixer();
  setupTopbarMaster();
  setupDialogs();
  setupWaveTools();
  setupHotcues();
  setupSampler();
  setupLoopsFx();
  setupKeyboard();
  setupSettings();
  setupMidi();
  setupPractice();
  setupNav();
  setupGlobalRecorder();
  setupPresets();
  setupDemoChips();
  updateDeckGuards("A");   // empty decks boot with their transport visibly guarded
  updateDeckGuards("B");
  attachTrackpadGestures(engine, ui, config);
  maybeStartTour();

  // Debug handle (handy in the console for testing/automation).
  window.sxratch = { engine, ui, analysers, hot, config, coach, get sampler() { return sampler; }, get midi() { return midi; } };

  // Layout class manager. Portrait phones get a REAL portrait layout
  // (body.portrait-mode) — the old approach of CSS-rotating the whole page
  // 90° is gone: native widgets, scrolling and viewport math all behave now.
  function updateLayoutClass() {
    const isStudio = document.body.classList.contains("view-studio");
    const isLandscape = window.innerWidth > window.innerHeight;
    const portrait = !isLandscape && !isStudio;

    const wasPortrait = document.body.classList.contains("portrait-mode");
    const wasLandscapeCls = document.body.classList.contains("use-landscape-layout");

    document.body.classList.toggle("use-landscape-layout", !portrait && !isStudio);
    document.body.classList.toggle("portrait-mode", portrait);

    if (wasPortrait !== portrait || wasLandscapeCls !== (!portrait && !isStudio)) {
      requestAnimationFrame(() => {
        sizePlatters();
        ui.waves.A?.resize();
        ui.waves.B?.resize();
      });
    }
  }

  // ONE relayout path (was copy-pasted across five listeners): re-derive the
  // layout class, resize the waveform canvases, refit the platters — coalesced
  // through a single rAF so bursts of resize events do the work once.
  let relayoutQueued = false;
  function relayout() {
    if (relayoutQueued) return;
    relayoutQueued = true;
    requestAnimationFrame(() => {
      relayoutQueued = false;
      updateLayoutClass();
      ui.waves.A?.resize();
      ui.waves.B?.resize();
      sizePlatters();
    });
  }

  // Crossfade fan-out: engine.setCrossfade fires this for EVERY source
  // (fader drag, keyboard, gestures, MIDI, coach), so UI sync and practice
  // instrumentation live in one place.
  engine.onCrossfade = (v) => {
    ui.syncCrossfade(v);
    coach?.onCrossfade(v);
  };

  // Keep the platters as perfect circles that fit the (dynamic) scratch zone.
  // The observer also re-derives the layout class: element resize fires even in
  // environments where window `resize` doesn't (viewport emulation, webviews).
  updateLayoutClass();
  new ResizeObserver(relayout).observe(document.getElementById("console")); // scratch-zone is display:contents in the landscape grid

  // Sampler / Beat FX dock toggle
  document.getElementById("drawer-btn")?.addEventListener("click", () => {
    const on = document.body.classList.toggle("drawer-open");
    document.getElementById("drawer-btn").classList.toggle("active", on);
    relayout();
  });

  window.addEventListener("resize", relayout);
  document.addEventListener("fullscreenchange", relayout);
  window.visualViewport?.addEventListener("resize", relayout);
  window.addEventListener("orientationchange", () => setTimeout(relayout, 100));

  // Backgrounded browsers (esp. iOS Safari) can suspend the AudioContext;
  // resume whenever the tab becomes visible again or returns from BFCache.
  document.addEventListener("visibilitychange", () => { if (!document.hidden) engine.resume(); });
  window.addEventListener("pageshow", () => engine.resume());

  // Focus containment for every .dialog (present or created later): trap Tab
  // while open, restore focus to the opener on close. Esc-close already exists.
  const dialogTraps = new Map();
  const onDialogToggle = (dlg) => {
    dialogTraps.get(dlg)?.();
    dialogTraps.delete(dlg);
    if (!dlg.hidden) dialogTraps.set(dlg, ui.trapFocus(dlg));
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.attributeName === "hidden" && m.target.classList?.contains("dialog")) onDialogToggle(m.target);
    }
  }).observe(document.body, { attributes: true, attributeFilter: ["hidden"], subtree: true });

  requestAnimationFrame(frameLoop);
}

/** Size each platter from stable viewport/shell geometry.
 * Avoid measuring the platter's own content box: that created a feedback loop
 * where restoring from a smaller browser/fullscreen state could keep shrinking
 * the jog wheels on each resize.
 */
function sizePlatters() {
  const shell = document.querySelector(".controller-shell");
  const topbar = document.getElementById("topbar");
  const shellRect = shell?.getBoundingClientRect();
  const topbarH = topbar?.getBoundingClientRect().height || 60;
  const portrait = document.body.classList.contains("portrait-mode");
  const minSize = portrait ? 96 : window.innerHeight < 560 ? 118 : 190;
  const maxSize = window.innerWidth >= 1500 ? 520 : 430;
  // Portrait: two platters share the width (shell is a 2-column grid);
  // landscape: three columns as before.
  const byViewport = portrait
    ? Math.min(window.innerWidth * 0.40, Math.max(96, (window.innerHeight - topbarH) * 0.26))
    : Math.min(
        window.innerWidth * 0.245,
        Math.max(120, (window.innerHeight - topbarH) * 0.54)
      );
  const byShell = shellRect
    ? Math.max(96, (shellRect.width / (portrait ? 2 : 3)) * (portrait ? 0.74 : 0.78))
    : byViewport;
  const size = Math.round(Math.max(minSize, Math.min(byViewport, byShell, maxSize)));
  document.documentElement.style.setProperty("--deck-platter-size", `${size}px`);
  for (const id of ["A", "B"]) {
    const pad = document.getElementById(`pad-${id}`);
    const plat = pad && pad.querySelector(".platter");
    if (!plat) continue;
    plat.style.width = "";
    plat.style.height = "";
  }
}

// ---------- Loading audio ----------
function setupLoading() {
  document.querySelectorAll(".load-btn").forEach((btn) => {
    const deck = btn.dataset.deck;
    const input = document.querySelector(`.file-input[data-deck="${deck}"]`);
    btn.addEventListener("click", () => input.click());
    input.addEventListener("change", () => {
      if (input.files[0]) loadFile(deck, input.files[0]);
      input.value = "";
    });
  });

  // Instant Doubles — copy a deck (track + position) onto the other.
  document.querySelectorAll(".dbl-btn").forEach((btn) =>
    btn.addEventListener("click", () => instantDoubles(btn.dataset.deck))
  );

  // Drag & drop onto a deck's waveform area or its scratch pad
  for (const id of ["A", "B"]) {
    const zones = [document.querySelector(`.deck-meta[data-deck="${id}"]`), document.getElementById(`pad-${id}`)];
    zones.forEach((zone) => {
      zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("dragover"); });
      zone.addEventListener("dragleave", () => zone.classList.remove("dragover"));
      zone.addEventListener("drop", (e) => {
        e.preventDefault();
        zone.classList.remove("dragover");
        const file = e.dataTransfer.files[0];
        if (file) loadFile(id, file);
      });
    });
  }

  // URL dialog
  const urlDialog = document.getElementById("url-dialog");
  const urlInput = document.getElementById("url-input");
  let urlDeck = "A";
  document.querySelectorAll(".url-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      urlDeck = btn.dataset.deck;
      urlInput.value = "";
      urlDialog.hidden = false;
      urlInput.focus();
    });
  });
  document.getElementById("url-cancel").addEventListener("click", () => (urlDialog.hidden = true));
  document.getElementById("url-load").addEventListener("click", () => {
    const url = urlInput.value.trim();
    if (url) loadURL(urlDeck, url);
    urlDialog.hidden = true;
  });
  urlInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") document.getElementById("url-load").click();
  });
}

async function loadFile(deck, file) {
  ui.toast(`Loading ${file.name}…`);
  try {
    const buf = await file.arrayBuffer();
    const audio = await engine.decode(buf);
    applyLoaded(deck, audio, file.name.replace(/\.[^.]+$/, ""));
  } catch (err) {
    console.error(err);
    ui.toast("Couldn't decode that file", { severity: "error" });
  }
}

async function loadURL(deck, url) {
  ui.toast("Fetching…");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000); // don't hang forever
  try {
    const res = await fetch(url, { mode: "cors", signal: ctrl.signal });
    if (!res.ok) throw new Error(res.status + "");
    // Stream with progress when the host reports a length — big files no
    // longer look frozen behind a single "Fetching…" toast.
    const total = Number(res.headers.get("content-length")) || 0;
    let buf;
    if (res.body && total > 0) {
      const reader = res.body.getReader();
      const chunks = [];
      let got = 0, lastPct = -1;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        const pct = Math.min(99, Math.floor((got / total) * 100));
        if (pct >= lastPct + 10) { lastPct = pct; ui.toast(`Fetching… ${pct}%`); }
      }
      const all = new Uint8Array(got);
      let o = 0;
      for (const c of chunks) { all.set(c, o); o += c.length; }
      buf = all.buffer;
    } else {
      buf = await res.arrayBuffer();
    }
    const audio = await engine.decode(buf);
    const name = decodeURIComponent(url.split("/").pop().split("?")[0]) || "track";
    applyLoaded(deck, audio, name.replace(/\.[^.]+$/, ""));
  } catch (err) {
    console.error(err);
    ui.toast(err && err.name === "AbortError"
      ? "Load timed out — the host is too slow or unreachable"
      : "Load failed — check the URL allows cross-origin (CORS)", { severity: "error" });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Load a decoded buffer onto a deck and refresh every readout.
 * opts.bpm   — known tempo (presets, PAD renders, doubles): shown immediately.
 * opts.detect — set false to skip BPM detection (FX one-shots, doubles).
 */
// Guarded-control styling: with no track loaded, a deck's transport and hot
// cues LOOK unavailable (aria-disabled + .is-disabled) while staying
// clickable, so activating one still explains itself via toast. Real
// `disabled` would silence that guidance.
function updateDeckGuards(deck) {
  const has = !!engine.decks[deck].buffer;
  document
    .querySelectorAll(`.transport[data-deck="${deck}"] .btn, .hotcues[data-deck="${deck}"] .hotcue-chip`)
    .forEach((b) => {
      b.classList.toggle("is-disabled", !has);
      if (has) b.removeAttribute("aria-disabled");
      else b.setAttribute("aria-disabled", "true");
    });
}

function applyLoaded(deck, audio, name, opts = {}) {
  engine.decks[deck].loadBuffer(audio, name);
  ui.waves[deck].setBuffer(audio);
  ui.setTitle(deck, name);
  ui.updatePosition(deck, 0);
  ui.setPlaying(deck, false);
  hot[deck] = Array(HOT_CUE_COUNT).fill(null); // fresh track, clear hot cues
  renderHot(deck);
  drawArtThumb(deck);
  updateDeckGuards(deck);

  if (demoChips[deck]) demoChips[deck].hidden = true;

  const token = ++bpmDetectToken[deck]; // any older in-flight detection is stale
  if (opts.bpm) {
    engine.decks[deck].setBpm(opts.bpm);
    bpmKnown[deck] = true;
    // Known tempo ⇒ anchored beat grid (PAD renders / presets start on the one).
    ui.waves[deck].setBeatGrid({ bpm: opts.bpm, offset: 0, anchored: true });
  } else {
    bpmKnown[deck] = false;
    ui.waves[deck].setBeatGrid(null);
    if (opts.detect !== false) {
      // Detect off the load path; only apply if this deck still holds the track.
      setTimeout(() => {
        if (bpmDetectToken[deck] !== token || engine.decks[deck].buffer !== audio) return;
        const found = detectBPM(audio);
        if (found && bpmDetectToken[deck] === token && engine.decks[deck].buffer === audio) {
          engine.decks[deck].setBpm(found);
          bpmKnown[deck] = true;
          ui.setBpm(deck, true);
          // Detected tempo ⇒ beat ticks only (downbeat unknown — no bar numbers).
          ui.waves[deck].setBeatGrid({ bpm: found, offset: 0, anchored: false });
        }
      }, 40);
    }
  }
  ui.setBpm(deck, bpmKnown[deck]);
  ui.toast(`Deck ${deck}: ${name}`);
}

/** Set a deck's BPM by hand (tap or typed) — readout, grid and FX sync follow. */
function setDeckBpm(deck, bpm) {
  const d = engine.decks[deck];
  if (!d.buffer) { ui.toast("Load a track first"); return false; }
  bpmDetectToken[deck]++; // cancel any in-flight auto-detection
  d.setBpm(bpm);
  bpmKnown[deck] = true;
  ui.setBpm(deck, true);
  // Manual tempo ⇒ beat ticks only (the downbeat is unknown — no bar numbers).
  ui.waves[deck].setBeatGrid({ bpm, offset: 0, anchored: false });
  return true;
}

/** Tap-to-set + double-click-to-type on a deck's BPM readout. */
function attachBpmEntry(el, deck) {
  const tapper = createTapTempo();
  let flashTimer = null;
  el.addEventListener("click", () => {
    const bpm = tapper.tap(performance.now());
    if (bpm == null) {
      if (tapper.count >= 1 && engine.decks[deck].buffer) {
        el.classList.add("tapping");
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => el.classList.remove("tapping"), 2100);
      }
      return;
    }
    if (setDeckBpm(deck, bpm)) ui.toast(`Deck ${deck}: tapped ${bpm} BPM`);
  });
  el.addEventListener("dblclick", (e) => {
    e.preventDefault();
    tapper.reset();
    el.classList.remove("tapping");
    const current = engine.decks[deck].bpm || 120;
    const typed = prompt(`Deck ${deck} BPM`, String(current));
    if (typed == null) return;
    const bpm = parseFloat(typed);
    if (!(bpm >= 40 && bpm <= 240)) { ui.toast("BPM must be 40–240", { severity: "error" }); return; }
    if (setDeckBpm(deck, Math.round(bpm * 10) / 10)) ui.toast(`Deck ${deck}: ${bpm} BPM set`);
  });
}

/** Render a real mini-waveform of the loaded track into the album-art tile. */
function drawArtThumb(deck) {
  const art = arts[deck];
  const wave = ui.waves[deck];
  if (!art || !wave || !wave.peaks || !wave.peakCount) return;
  let cv = art.querySelector("canvas");
  if (!cv) { cv = document.createElement("canvas"); art.appendChild(cv); }
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(24, art.clientWidth || 64);
  const h = Math.max(24, art.clientHeight || 64);
  cv.width = Math.round(w * dpr);
  cv.height = Math.round(h * dpr);
  const ctx = cv.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = DECK_COLORS[deck];
  ctx.globalAlpha = 0.85;
  const n = wave.peakCount, mid = h / 2;
  for (let x = 0; x < w; x++) {
    const p = Math.min(n - 1, Math.floor((x / w) * n));
    const min = wave.peaks[p * 2], max = wave.peaks[p * 2 + 1];
    ctx.beginPath();
    ctx.moveTo(x + 0.5, mid - max * (mid - 1));
    ctx.lineTo(x + 0.5, mid - min * (mid - 1) + 0.5);
    ctx.stroke();
  }
  art.classList.add("has-art");
}

function instantDoubles(from) {
  const src = engine.decks[from];
  if (!src.buffer) { ui.toast(`Deck ${from} is empty`); return; }
  const to = from === "A" ? "B" : "A";
  applyLoaded(to, src.buffer, src.name, {
    bpm: bpmKnown[from] ? src.bpm : null,
    detect: false, // same audio — copying the source deck's knowledge is truthful
  });
  engine.decks[to].seek(src.position);
  if (src.playing) engine.decks[to].play();
  ui.toast(`Doubled ${from} → ${to}`);
}

// ---------- Global Mix Recorder ----------
function setupGlobalRecorder() {
  const recBtn = document.getElementById("record-btn");
  if (!recBtn) return;
  // The button is [red dot][label] — only the label text changes.
  const recLabel = () => recBtn.querySelector(".rec-label") || recBtn;

  const recorder = createMixRecorder(engine);
  let startTime = 0;
  let timerInterval = null;

  const download = (blob, ext) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `sxratch-mix-${new Date().toISOString().slice(0, 10)}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  };

  const resetUI = () => {
    clearInterval(timerInterval);
    recBtn.classList.remove("recording");
    document.body.classList.remove("recording");
    recLabel().textContent = "REC";
  };

  if (recorder) {
    recorder.onerror = (msg) => { resetUI(); ui.toast(msg); ui.announce?.(msg); };
  }

  // Also offer a lossless WAV alongside the compressed take (decode the blob
  // through the live context, then reuse the PAD's WAV encoder). Capped: a
  // decoded float mix is ~23 MB/min, so very long takes ship compressed-only.
  const WAV_CAP_SECONDS = 12 * 60;
  const offerWav = async (blob) => {
    try {
      const buf = await engine.ctx.decodeAudioData(await blob.arrayBuffer());
      if (buf.duration > WAV_CAP_SECONDS) {
        ui.toast("Take over 12 min — saved compressed only");
        return;
      }
      download(bufferToWav(buf), "wav");
    } catch (err) {
      console.warn("WAV conversion failed; compressed file already saved", err);
    }
  };

  recBtn.addEventListener("click", async () => {
    if (!recorder) {
      ui.toast("Recording is not supported in this browser", { severity: "error" });
      return;
    }
    if (!recorder.recording) {
      if (!recorder.start()) return; // onerror already surfaced it
      startTime = Date.now();
      recBtn.classList.add("recording");
      document.body.classList.add("recording"); // subtle red frame on the whole rig
      ui.toast("Recording started");
      ui.announce?.("Recording started");
      timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        const m = Math.floor(elapsed / 60);
        const s = elapsed % 60;
        recLabel().textContent = `REC ${m}:${s.toString().padStart(2, "0")}`;
      }, 1000);
    } else {
      const took = Math.round((Date.now() - startTime) / 1000);
      const result = await recorder.stop();
      resetUI();
      if (!result) { ui.toast("Nothing was recorded", { severity: "error" }); return; }
      download(result.blob, result.ext);
      ui.toast("Mix saved — preparing WAV…", { severity: "ok" });
      ui.announce?.(`Recording stopped — ${Math.floor(took / 60)} minutes ${took % 60} seconds saved`);
      offerWav(result.blob);
    }
  });
}

// ---------- Presets Loader ----------
function setupPresets() {
  document.querySelectorAll(".preset-select").forEach((sel) => {
    sel.addEventListener("change", async () => {
      const deckId = sel.dataset.deck || "A";
      const val = sel.value;
      if (!val) return;
      sel.disabled = true;

      try {
        let buffer = null;
        let label = "";
        let opts = { detect: false }; // synth FX one-shots have no meaningful BPM

        if (val === "scratch") {
          label = "Scratch Tool (Synth)";
          buffer = generateScratchPreset(engine.ctx);
        } else if (val === "laser") {
          label = "Laser Preset (Synth)";
          buffer = generateLaserPreset(engine.ctx);
        } else if (val === "beat") {
          label = "Practice Beat (100 BPM)";
          buffer = makeBeat(engine.ctx, 100, 24);
          opts = { bpm: 100 }; // known tempo — show it immediately
        }

        if (buffer) {
          applyLoaded(deckId, buffer, label, opts);
        }
      } catch (err) {
        console.error(err);
        ui.toast("Couldn't generate that preset", { severity: "error" });
      } finally {
        sel.disabled = false;
        sel.value = ""; // reset selector placeholder
      }
    });
  });
}

// ---------- Demo chips + first-run tour ----------
function setupDemoChips() {
  const load = {
    A: () => applyLoaded("A", makeBeat(engine.ctx, 100, 24), "Demo Beat (100 BPM)", { bpm: 100 }),
    B: () => applyLoaded("B", generateScratchPreset(engine.ctx), "Scratch Tool (Synth)", { detect: false }),
  };
  for (const id of ["A", "B"]) {
    demoChips[id]?.addEventListener("click", (e) => {
      e.stopPropagation();
      load[id]();
    });
  }
}

/**
 * First-run coach marks: short steps over live UI. Reuses the practice-mode
 * .coach-target highlight. Runs once per flagKey (localStorage); "Skip" and
 * Esc both end it. One generic runner serves the deck tour AND the PAD tour.
 */
let activeQuickTourEnd = null;
function runTour(flagKey, steps) {
  try { if (localStorage.getItem(flagKey)) return; } catch {}
  if (document.getElementById("tour-tip")) return; // one tour at a time
  let i = -1, target = null;
  const tip = document.createElement("div");
  tip.id = "tour-tip";
  tip.setAttribute("role", "dialog");
  tip.setAttribute("aria-label", "Quick tour");
  tip.innerHTML = `<p class="tour-text"></p>
    <div class="tour-actions">
      <span class="tour-count"></span>
      <button type="button" class="btn tour-skip">Skip</button>
      <button type="button" class="btn primary tour-next">Next</button>
    </div>`;
  const end = () => {
    try { localStorage.setItem(flagKey, "1"); } catch {}
    target?.classList.remove("coach-target");
    tip.remove();
    window.removeEventListener("keydown", onKey, true);
    if (activeQuickTourEnd === end) activeQuickTourEnd = null;
  };
  activeQuickTourEnd = end;
  const show = () => {
    i++;
    target?.classList.remove("coach-target");
    if (i >= steps.length) { end(); return; }
    target = document.querySelector(steps[i].sel);
    if (!target) { show(); return; }
    target.classList.add("coach-target");
    tip.querySelector(".tour-text").textContent = steps[i].text;
    tip.querySelector(".tour-count").textContent = `${i + 1} / ${steps.length}`;
    tip.querySelector(".tour-next").textContent = i === steps.length - 1 ? "Done" : "Next";
  };
  const onKey = (e) => { if (e.code === "Escape") { end(); e.stopPropagation(); } };
  tip.querySelector(".tour-skip").addEventListener("click", end);
  tip.querySelector(".tour-next").addEventListener("click", show);
  window.addEventListener("keydown", onKey, true);
  document.body.appendChild(tip);
  show();
  tip.querySelector(".tour-next").focus();
}

function maybeStartTour() {
  const coarse = window.matchMedia("(pointer: coarse)").matches;
  runTour("sxratch.toured", [
    { sel: ".wave-stage", text: "Load a track: tap a LOAD DEMO chip, drop an audio file anywhere on a deck, or use LOAD / LINK." },
    { sel: "#pad-A", text: coarse ? "This is the platter — press and drag left/right to scratch." : "This is the platter — press-drag to scratch, or hold right Ctrl and move one finger on the trackpad." },
    { sel: "#crossfader", text: "The crossfader blends Deck A and B. It snaps to the centre notch — double-click any control to reset it." },
  ]);
}

/** The studio's own steps, on first PAD entry (anchored to the DAW shell). */
function maybeStartPadTour() {
  runTour("sxratch.dawtoured", [
    { sel: "#daw-heads", text: "Tracks live here — synths, drum kits and audio. M mutes, S solos, ⏺ arms a track for recording. ＋ adds more." },
    { sel: "#daw-timeline", text: "The timeline holds regions: drag to move, pull the edges to resize, double-click to edit notes. The ✏ tool draws new regions, ✂ splits them." },
    { sel: ".daw-transport", text: "Play, loop and record from here. Arm an audio track and press ● to record your mic or interface while the other tracks play." },
  ]);
}

// ---------- Sampler ----------
function setupSampler() {
  sampler = new Sampler(engine, 8);
  const wrap = document.getElementById("sampler-pads");
  wrap.innerHTML = "";
  for (let i = 0; i < 8; i++) {
    const pad = document.createElement("div");
    pad.className = "samp-pad";
    pad.dataset.slot = String(i);
    // Keyboard/AT support for what is visually a pad surface.
    pad.setAttribute("role", "button");
    pad.tabIndex = 0;
    pad.innerHTML = `<input type="file" accept="audio/*" hidden /><button class="samp-stop" title="Stop" aria-label="Stop sample ${i + 1}" tabindex="-1">■</button><span class="samp-key"></span><span class="samp-name">empty</span>`;
    const input = pad.querySelector("input");
    pad.querySelector(".samp-stop").addEventListener("click", (e) => { e.stopPropagation(); sampler.stop(i); });
    pad.addEventListener("keydown", (e) => {
      if (e.code === "Enter" || e.code === "Space") { e.preventDefault(); e.stopPropagation(); pad.click(); }
      else if (e.code === "Delete" || e.code === "Backspace") { e.preventDefault(); sampler.stop(i); }
    });
    pad.addEventListener("click", (e) => {
      if (pad.dataset.longpressed) { delete pad.dataset.longpressed; return; } // swallow the click after a long-press clear
      if (mappingSource) {
        mapRegionToPad(mappingSource.deckId, mappingSource.start, mappingSource.end, i);
        cancelMappingMode();
        return;
      }
      if (sampler.slots[i]) triggerSample(i);
      else input.click();
    });
    // Clear = LONG-PRESS (600 ms), not dblclick: double-clicking fired the
    // sample twice before clearing it. Delete/Backspace still clears too.
    let pressTimer = null;
    pad.addEventListener("pointerdown", () => {
      if (!sampler.slots[i]) return;
      pressTimer = setTimeout(() => {
        pad.dataset.longpressed = "1";
        sampler.clear(i);
        renderPad(i);
        haptic(20);
        ui.toast(`Pad ${i + 1} cleared`);
      }, 600);
    });
    const cancelPress = () => { clearTimeout(pressTimer); };
    pad.addEventListener("pointerup", cancelPress);
    pad.addEventListener("pointerleave", cancelPress);
    pad.addEventListener("pointercancel", cancelPress);
    pad.addEventListener("keydown", (e) => {
      if ((e.code === "Delete" || e.code === "Backspace") && e.shiftKey) { e.preventDefault(); sampler.clear(i); renderPad(i); }
    });
    input.addEventListener("change", async () => {
      if (input.files[0]) {
        ui.toast(`Loading pad ${i + 1}…`);
        try { await sampler.load(i, input.files[0]); renderPad(i); ui.toast(`Pad ${i + 1}: ${sampler.slots[i].name}`); }
        catch { ui.toast("Couldn't decode that sound", { severity: "error" }); }
      }
      input.value = "";
    });
    wrap.append(pad);
  }
  sampler.onChange = (i) => {
    const pad = document.querySelector(`.samp-pad[data-slot="${i}"]`);
    if (pad) pad.classList.toggle("playing", sampler.isPlaying(i));
  };
  renderPads();
  document.getElementById("samp-stopall").addEventListener("click", () => sampler.stopAll());
  const vol = document.getElementById("sampler-vol");
  sampler.setVolume(parseFloat(vol.value));
  vol.addEventListener("input", () => sampler.setVolume(parseFloat(vol.value)));
}

function triggerSample(i, vel = 1) { if (sampler && sampler.trigger(i, vel)) { flashPad(i); haptic(8); } }
function flashPad(i) {
  const pad = document.querySelector(`.samp-pad[data-slot="${i}"]`);
  if (!pad) return;
  pad.classList.add("hit");
  setTimeout(() => pad.classList.remove("hit"), 150);
}
function renderPad(i) {
  const pad = document.querySelector(`.samp-pad[data-slot="${i}"]`);
  if (!pad) return;
  const s = sampler.slots[i];
  pad.classList.toggle("loaded", !!s);
  pad.querySelector(".samp-name").textContent = s ? s.name : "empty";
  pad.querySelector(".samp-key").textContent = fmtKey(config.keys["samp" + (i + 1)]);
  pad.setAttribute("aria-label", s
    ? `Sampler pad ${i + 1}: ${s.name} — Enter fires, Delete stops`
    : `Sampler pad ${i + 1}: empty — Enter loads a sound`);
}
function renderPads() { for (let i = 0; i < 8; i++) renderPad(i); }

// ---------- Transport ----------
function setupTransport() {
  document.querySelectorAll(".play-btn").forEach((btn) =>
    btn.addEventListener("click", () => engine.decks[btn.dataset.deck].toggle())
  );
  document.querySelectorAll(".cue-btn").forEach((btn) =>
    btn.addEventListener("click", () => { engine.decks[btn.dataset.deck].goToCue(); coach?.notify(`cue${btn.dataset.deck}`); })
  );
  document.querySelectorAll(".set-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      engine.decks[btn.dataset.deck].setCue();
      ui.toast(`Deck ${btn.dataset.deck}: cue set`);
      coach?.notify(`setCue${btn.dataset.deck}`);
    })
  );

  // To-start, rewind / fast-forward (hold), sync, play-both
  document.querySelectorAll(".tp-start").forEach((btn) =>
    btn.addEventListener("click", () => engine.decks[btn.dataset.deck].seek(0))
  );
  document.querySelectorAll(".tp-rew").forEach((btn) => holdScan(btn, btn.dataset.deck, -6));
  document.querySelectorAll(".tp-ff").forEach((btn) => holdScan(btn, btn.dataset.deck, 6));
  document.querySelectorAll(".sync-btn").forEach((btn) =>
    btn.addEventListener("click", () => syncDeck(btn.dataset.deck))
  );
  bothBtn = document.getElementById("both-btn");
  bothBtn.addEventListener("click", playBoth);
}

let bothBtn = null;

/** Hold a button to scan the deck forward/backward at `rate` (audible). */
function holdScan(btn, id, rate) {
  const d = engine.decks[id];
  let timer = null;
  const start = (e) => {
    e.preventDefault();
    d.touchStart(); d.jog(rate);
    btn.classList.add("held");
    timer = setInterval(() => d.jog(rate), 33); // keep the jog fresh as it decays
  };
  const stop = () => {
    if (!timer) return;
    clearInterval(timer); timer = null;
    d.touchEnd();
    btn.classList.remove("held");
  };
  btn.addEventListener("pointerdown", start);
  btn.addEventListener("pointerup", stop);
  btn.addEventListener("pointerleave", stop);
  btn.addEventListener("pointercancel", stop);
}

/** Play or pause BOTH decks together. */
function playBoth() {
  if (engine.decks.A.playing || engine.decks.B.playing) {
    engine.decks.A.pause(); engine.decks.B.pause();
  } else {
    engine.decks.A.play(); engine.decks.B.play();
  }
}

/** Beat-match a deck to the other: match BPM (via tempo) and align the beat phase. */
function syncDeck(id) {
  const d = engine.decks[id];
  const otherId = id === "A" ? "B" : "A";
  const m = engine.decks[otherId];
  if (!d.buffer || !m.buffer) { ui.toast("Load both decks to sync"); return; }
  const masterEff = m.bpm * (1 + m.tempo / 100);
  const target = Math.max(-8, Math.min(8, (masterEff / d.bpm - 1) * 100));
  tempoFaders[id]?.set(target); // moves the fader + applies tempo + readout
  // Align this deck's beat phase to the master's.
  const eff = d.bpm * (1 + target / 100);
  if (d.duration > 0 && m.duration > 0) {
    const beatM = 60 / masterEff, beatD = 60 / eff;
    const mPhase = ((m.position * m.duration) % beatM + beatM) % beatM;
    const dTime = d.position * d.duration;
    const dPhase = (dTime % beatD + beatD) % beatD;
    let delta = mPhase - dPhase;
    if (delta > beatD / 2) delta -= beatD;
    if (delta < -beatD / 2) delta += beatD;
    d.seek(Math.max(0, Math.min(1, (dTime + delta) / d.duration)));
  }
  ui.toast(`Synced ${id}→${otherId} · ${eff.toFixed(1)} BPM`);
}

// ---------- Mixer ----------
function setupMixer() {
  // Channel knobs — TRIM, 3-band EQ and FILTER — each with a tick scale + arc.
  document.querySelectorAll(".knob").forEach((el) => {
    const deck = el.dataset.deck;
    const band = el.dataset.band;
    const svg = el.closest(".knob-dial").querySelector(".knob-scale");
    const setArc = buildKnobScale(svg, band === "filter" ? themeColors().accent : DECK_COLORS[deck]);
    knobArcs.push({ svg, band, deck, setArc });
    let value = 0.5, dflt = 0.5, apply;
    if (band === "trim") { value = dflt = 0.67; apply = (v) => engine.decks[deck].setTrim(v); }
    else if (band === "filter") { value = dflt = 0.5; apply = (v) => engine.decks[deck].setFilter(v); }
    else { apply = (v) => { engine.decks[deck].setEQ(band, v); coach?.notify("eq"); }; }
    const BAND_NAMES = { trim: "trim", high: "high EQ", mid: "mid EQ", low: "low EQ", filter: "filter" };
    const kh = attachKnob(el, {
      value, default: dflt,
      indicator: el, // rotate the whole knob so the dot orbits its centre
      label: `Deck ${deck} ${BAND_NAMES[band] || band}`,
      onChange: (v) => { apply(v); setArc(v); },
    });
    // Every channel knob is a MIDI target: eqAlow/eqAmid/eqAhigh, trimA,
    // filterA (and legacy eqA = mid) — all remappable via MIDI Learn.
    if (band === "mid") midiTargets["eq" + deck] = (v) => kh.set(v);
    const targetId = band === "trim" || band === "filter" ? band + deck : "eq" + deck + band;
    midiTargets[targetId] = (v) => kh.set(v);
    apply(value); setArc(value);
  });

  // Volume faders (vertical, neutral = unity)
  for (const id of ["A", "B"]) {
    const start = 0.85;
    engine.decks[id].setVolume(start);
    const vh = attachFader(document.getElementById(`vol-${id}`), {
      min: 0, max: 1, value: start, default: 1,
      label: `Deck ${id} volume`,
      valueText: (v) => Math.round(v * 100) + "%",
      ticks: [0, 0.25, 0.5, 0.75, 1].map((at) => ({ at, major: at === 1 })),
      onChange: (v) => engine.decks[id].setVolume(v),
    });
    midiTargets["vol" + id] = (v) => vh.set(v);
  }

  // Tempo faders (vertical, ±8%, neutral = 0)
  for (const id of ["A", "B"]) {
    const read = document.getElementById(`tempo-${id}-read`);
    const fmt = (v) => `${v > 0 ? "+" : v < 0 ? "−" : "±"}${Math.abs(v).toFixed(1)}%`;
    tempoFaders[id] = attachFader(document.getElementById(`tempo-${id}`), {
      min: -8, max: 8, value: 0, default: 0, step: 0.1,
      label: `Deck ${id} tempo`,
      valueText: fmt,
      ticks: [
        { at: 8, label: "+8", major: true }, { at: 4 }, { at: 0, major: true },
        { at: -4 }, { at: -8, label: "−8", major: true },
      ],
      onChange: (v) => {
        engine.decks[id].setTempo(v);
        read.textContent = fmt(v);
        ui.setBpm(id, bpmKnown[id]); // effective BPM follows the tempo fader
        coach?.notify("tempo");
      },
    });
    read.textContent = fmt(0);
  }

  // Crossfader (horizontal, neutral = centre, magnetic centre notch)
  const cf = attachFader(document.getElementById("crossfader"), {
    min: 0, max: 1, value: 0.5, default: 0.5,
    label: "Crossfader",
    valueText: (v) => (v === 0.5 ? "centre" : v < 0.5 ? `${Math.round((0.5 - v) * 200)}% toward A` : `${Math.round((v - 0.5) * 200)}% toward B`),
    ticks: [0, 0.25, 0.5, 0.75, 1].map((at) => ({ at, major: at === 0.5 })),
    detent: { at: 0.5, radius: 0.02, onSnap: () => haptic(6) },
    onChange: (v) => engine.setCrossfade(v),
  });
  ui.crossfadeSet = cf.set; // let keyboard / gestures move the on-screen fader
  midiTargets.crossfade = (v) => cf.set(v); // and MIDI

  // Master (hidden native slider keeps the value; the real control is the
  // topbar knob built in setupTopbarMaster)
  const master = document.getElementById("master-vol");
  engine.setMasterVolume(parseFloat(master.value));
  master.addEventListener("input", () => engine.setMasterVolume(parseFloat(master.value)));
}

/**
 * Topbar master strip: a REAL knob (drag ↕ / wheel / double-click to 90%) and
 * a live output meter with peak-hold — replacing the painted decorations.
 */
function setupTopbarMaster() {
  const wrap = document.querySelector("#topbar .master");
  const input = document.getElementById("master-vol");
  if (!wrap || !input || wrap.querySelector(".master-knob")) return;

  const vu = document.createElement("div");
  vu.className = "master-vu";
  vu.setAttribute("aria-hidden", "true");
  vu.innerHTML = "<i></i>";

  const knob = document.createElement("div");
  knob.className = "master-knob";
  knob.innerHTML = '<span class="knob-dot"></span>';
  knob.title = "Master volume — drag ↕ · wheel · double-click = 90%";
  knob.setAttribute("role", "slider");
  knob.setAttribute("aria-label", "Master volume");
  knob.setAttribute("aria-valuemin", "0");
  knob.setAttribute("aria-valuemax", "1");

  wrap.append(vu, knob);
  attachKnob(knob, {
    value: parseFloat(input.value),
    default: 0.9,
    onChange: (v) => {
      engine.setMasterVolume(v);
      input.value = String(v); // keep the hidden slider (and anything reading it) in sync
    },
  });

  // Live output level, tapped at the chain's final node (post-limiter AND
  // post master volume — the meter shows what actually leaves the app).
  masterAnalyser = engine.ctx.createAnalyser();
  masterAnalyser.fftSize = 256;
  masterBuf = new Float32Array(masterAnalyser.fftSize);
  engine.master.connect(masterAnalyser);
  masterVuEl = vu;
}

/**
 * Draw a tick scale + value arc into a knob's SVG. Returns setArc(value 0..1)
 * that fills an arc from neutral (12 o'clock) to the current position.
 */
function buildKnobScale(svg, color) {
  const NS = "http://www.w3.org/2000/svg";
  const cx = 50, cy = 50, rTickOuter = 48, rTickInner = 42, rArc = 45;
  const polar = (r, deg) => {
    const a = (deg * Math.PI) / 180;
    return [cx + r * Math.sin(a), cy - r * Math.cos(a)];
  };
  svg.innerHTML = "";
  // Ticks every 33.75° across the 270° sweep (-135 .. +135).
  for (let i = 0; i <= 8; i++) {
    const deg = -135 + i * 33.75;
    const major = i === 0 || i === 4 || i === 8;
    const [x1, y1] = polar(rTickInner, deg);
    const [x2, y2] = polar(rTickOuter, deg);
    const line = document.createElementNS(NS, "line");
    line.setAttribute("x1", x1); line.setAttribute("y1", y1);
    line.setAttribute("x2", x2); line.setAttribute("y2", y2);
    line.setAttribute("stroke", major ? "currentColor" : "currentColor");
    line.setAttribute("stroke-opacity", major ? 0.55 : 0.22);
    line.setAttribute("stroke-width", major ? 2.4 : 1.4);
    line.setAttribute("stroke-linecap", "round");
    svg.append(line);
  }
  const arc = document.createElementNS(NS, "path");
  arc.setAttribute("fill", "none");
  arc.setAttribute("stroke", color);
  arc.setAttribute("stroke-width", 3);
  arc.setAttribute("stroke-linecap", "round");
  svg.append(arc);

  const describe = (start, end) => {
    const [sx, sy] = polar(rArc, start);
    const [ex, ey] = polar(rArc, end);
    const large = Math.abs(end - start) > 180 ? 1 : 0;
    return `M ${sx} ${sy} A ${rArc} ${rArc} 0 ${large} 1 ${ex} ${ey}`;
  };
  return (value) => {
    const a = (value - 0.5) * 270;
    if (Math.abs(a) < 0.6) arc.setAttribute("d", "");
    else arc.setAttribute("d", a > 0 ? describe(0, a) : describe(a, 0));
  };
}

// ---------- Keyboard (configurable) ----------
// UI sync happens in engine.onCrossfade (registered in setup), so every caller
// just moves the engine — one crossfade path for keyboard, gestures and coach.
function setCrossUI(v) {
  engine.setCrossfade(Math.max(0, Math.min(1, v)));
}

function buildActions() {
  const A = engine.decks.A, B = engine.decks.B;
  const cue = (id, slot) => (e) => (e.shiftKey ? clearCue(id, slot) : hitCue(id, slot));
  return {
    playA: () => { A.toggle(); ui.flash("A"); },
    playB: () => { B.toggle(); ui.flash("B"); },
    cueA: () => { A.goToCue(); coach?.notify("cueA"); },
    cueB: () => { B.goToCue(); coach?.notify("cueB"); },
    setCueA: () => { A.setCue(); ui.toast("Deck A: cue set"); coach?.notify("setCueA"); },
    setCueB: () => { B.setCue(); ui.toast("Deck B: cue set"); coach?.notify("setCueB"); },
    crossLeft: () => setCrossUI(engine.crossfade - 0.05),
    crossRight: () => setCrossUI(engine.crossfade + 0.05),
    crossCenter: () => setCrossUI(0.5),
    hotA1: cue("A", 0), hotA2: cue("A", 1), hotA3: cue("A", 2), hotA4: cue("A", 3),
    hotA5: cue("A", 4), hotA6: cue("A", 5), hotA7: cue("A", 6), hotA8: cue("A", 7),
    hotB1: cue("B", 0), hotB2: cue("B", 1), hotB3: cue("B", 2), hotB4: cue("B", 3),
    hotB5: cue("B", 4), hotB6: cue("B", 5), hotB7: cue("B", 6), hotB8: cue("B", 7),
    samp1: () => triggerSample(0), samp2: () => triggerSample(1), samp3: () => triggerSample(2), samp4: () => triggerSample(3),
    samp5: () => triggerSample(4), samp6: () => triggerSample(5), samp7: () => triggerSample(6), samp8: () => triggerSample(7),
    loopA: () => toggleAutoLoop("A"), loopB: () => toggleAutoLoop("B"),
    playBoth: () => playBoth(), syncA: () => syncDeck("A"), syncB: () => syncDeck("B"),
  };
}

let rebindCapture = null; // { type:'keys'|'gestures', name } while listening for a key

function setupKeyboard() {
  rebuildKeyMap();
  const actions = buildActions();

  // Capture phase: when rebinding, the next key press becomes the binding and
  // is swallowed so it can't also trigger an action / arm a deck.
  window.addEventListener("keydown", (e) => {
    if (!rebindCapture) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.code !== "Escape") {
      config[rebindCapture.type][rebindCapture.name] = e.code;
      rebuildKeyMap();
      saveConfig();
      if (sampler) renderPads();
    }
    rebindCapture = null;
    renderSettings();
  }, true);

  // Action dispatch (bubble phase).
  window.addEventListener("keydown", (e) => {
    if (rebindCapture) return;
    if (!document.getElementById("settings-dialog").hidden) return; // not while editing
    if (e.target.closest && e.target.closest('input[type="url"], input[type="text"], textarea')) return;
    // Ctrl/Alt/Cmd are reserved for gesture arming/slam; Shift is allowed
    // because it means "clear" for hot cues.
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const action = keyMap[e.code];
    if (!action) return;
    const repeatable = action === "crossLeft" || action === "crossRight";
    if (e.repeat && !repeatable) return;
    actions[action]?.(e);
    if (action.startsWith("cross") || action === "playBoth") e.preventDefault();
  });
}

// ---------- Settings / remapping panel ----------
const KEY_ACTION_GROUPS = [
  ["Transport", [["playA", "Play / pause A"], ["playB", "Play / pause B"], ["cueA", "Cue A (jump)"], ["cueB", "Cue B (jump)"], ["setCueA", "Set cue A"], ["setCueB", "Set cue B"]]],
  ["Crossfader", [["crossLeft", "Nudge toward A"], ["crossRight", "Nudge toward B"], ["crossCenter", "Centre"]]],
  ["Sync & both", [["playBoth", "Play / pause both"], ["syncA", "Sync A → B"], ["syncB", "Sync B → A"]]],
  ["Loops", [["loopA", "Auto-loop Deck A"], ["loopB", "Auto-loop Deck B"]]],
  ["Hot cues — Deck A", [["hotA1", "Cue 1"], ["hotA2", "Cue 2"], ["hotA3", "Cue 3"], ["hotA4", "Cue 4"], ["hotA5", "Cue 5"], ["hotA6", "Cue 6"], ["hotA7", "Cue 7"], ["hotA8", "Cue 8"]]],
  ["Hot cues — Deck B", [["hotB1", "Cue 1"], ["hotB2", "Cue 2"], ["hotB3", "Cue 3"], ["hotB4", "Cue 4"], ["hotB5", "Cue 5"], ["hotB6", "Cue 6"], ["hotB7", "Cue 7"], ["hotB8", "Cue 8"]]],
  ["Sampler pads", [["samp1", "Pad 1"], ["samp2", "Pad 2"], ["samp3", "Pad 3"], ["samp4", "Pad 4"], ["samp5", "Pad 5"], ["samp6", "Pad 6"], ["samp7", "Pad 7"], ["samp8", "Pad 8"]]],
];
const GESTURE_KEYS = [
  ["armA", "Arm Deck A (hold to scratch)"], ["armB", "Arm Deck B (hold to scratch)"],
  ["slamAMod", "Slam to A (with arm A)"], ["slamBMod", "Slam to B (with arm B)"],
];

function fmtKey(code) {
  if (!code) return "—";
  const map = {
    ControlLeft: "L-Ctrl", ControlRight: "R-Ctrl", ShiftLeft: "L-Shift", ShiftRight: "R-Shift",
    AltLeft: "L-Alt", AltRight: "R-Alt", MetaLeft: "L-⌘", MetaRight: "R-⌘",
    ArrowLeft: "←", ArrowRight: "→", ArrowUp: "↑", ArrowDown: "↓", Space: "Space", Escape: "Esc",
  };
  if (map[code]) return map[code];
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  if (code.startsWith("Numpad")) return "Num " + code.slice(6);
  return code;
}

function renderSettings() {
  const body = document.getElementById("settings-body");
  body.innerHTML = "";

  const keyBtn = (type, name) => {
    const capturing = rebindCapture && rebindCapture.type === type && rebindCapture.name === name;
    const b = document.createElement("button");
    b.className = "key-btn" + (capturing ? " capturing" : "");
    b.textContent = capturing ? "press a key…" : fmtKey(config[type][name]);
    b.addEventListener("click", () => { rebindCapture = { type, name }; renderSettings(); });
    return b;
  };

  const addRows = (title, rows, type) => {
    const h = document.createElement("div"); h.className = "set-group-title"; h.textContent = title;
    body.append(h);
    for (const [name, label] of rows) {
      const row = document.createElement("div"); row.className = "set-row";
      const l = document.createElement("span"); l.textContent = label;
      row.append(l, keyBtn(type, name));
      body.append(row);
    }
  };

  for (const [title, rows] of KEY_ACTION_GROUPS) addRows(title, rows, "keys");
  addRows("Trackpad arming & slam", GESTURE_KEYS, "gestures");

  const h = document.createElement("div"); h.className = "set-group-title"; h.textContent = "Trackpad feel";
  body.append(h);

  const invRow = document.createElement("label"); invRow.className = "set-row";
  const invL = document.createElement("span"); invL.textContent = "Invert scratch direction";
  const inv = document.createElement("input"); inv.type = "checkbox"; inv.checked = config.gestures.invertScratch;
  inv.addEventListener("change", () => { config.gestures.invertScratch = inv.checked; saveConfig(); });
  invRow.append(invL, inv); body.append(invRow);

  const slider = (label, key, min, max, step) => {
    const row = document.createElement("div"); row.className = "set-row";
    const l = document.createElement("span"); l.textContent = label;
    const r = document.createElement("input"); r.type = "range"; r.min = min; r.max = max; r.step = step;
    r.value = config.gestures[key];
    r.addEventListener("input", () => { config.gestures[key] = parseFloat(r.value); saveConfig(); });
    row.append(l, r); body.append(row);
  };
  slider("Scratch sensitivity", "scratchSensitivity", 0.0006, 0.004, 0.0001);
  slider("Crossfade sensitivity", "crossfadeSensitivity", 0.001, 0.01, 0.0002);

  const opt = (val, txt, sel) => {
    const o = document.createElement("option");
    o.value = val;
    o.textContent = txt;
    if (sel) o.selected = true;
    return o;
  };

  const cfTitle = document.createElement("div"); cfTitle.className = "set-group-title"; cfTitle.textContent = "Crossfader settings";
  body.append(cfTitle);

  // Crossfader Curve Row
  const curveRow = document.createElement("div"); curveRow.className = "set-row";
  const curveL = document.createElement("span"); curveL.textContent = "Crossfader curve";
  const curveS = document.createElement("select");
  curveS.className = "preset-select";
  curveS.style.minHeight = "28px";
  curveS.style.padding = "2px 6px";
  curveS.appendChild(opt("power", "Equal Power", config.gestures.crossfadeCurve === "power"));
  curveS.appendChild(opt("linear", "Linear Blend", config.gestures.crossfadeCurve === "linear"));
  curveS.appendChild(opt("cut", "Sharp Cut (Scratch)", config.gestures.crossfadeCurve === "cut"));
  curveS.addEventListener("change", () => {
    config.gestures.crossfadeCurve = curveS.value;
    engine.crossfadeCurve = curveS.value;
    engine.setCrossfade(engine.crossfade); // re-apply
    saveConfig();
  });
  curveRow.append(curveL, curveS);
  body.append(curveRow);

  // Hamster Switch Row
  const hamRow = document.createElement("label"); hamRow.className = "set-row";
  const hamL = document.createElement("span"); hamL.textContent = "Hamster mode (Reverse crossfader)";
  const ham = document.createElement("input"); ham.type = "checkbox"; ham.checked = config.gestures.hamsterMode;
  ham.addEventListener("change", () => {
    config.gestures.hamsterMode = ham.checked;
    engine.hamster = ham.checked;
    engine.setCrossfade(engine.crossfade); // re-apply
    saveConfig();
  });
  hamRow.append(hamL, ham);
  body.append(hamRow);

  renderAppearanceSettings(body);
  renderMidiHapticsSettings(body);
}

function renderAppearanceSettings(body) {
  const title = document.createElement("div");
  title.className = "set-group-title";
  title.textContent = "Appearance";
  body.append(title);

  const row = document.createElement("label");
  row.className = "set-row";
  const l = document.createElement("span");
  l.textContent = "Theme";
  const sel = document.createElement("select");
  sel.id = "theme-select";
  sel.className = "set-select";
  [["auto", "Follow system"], ["light", "Light"], ["dark", "Dark"]].forEach(([v, t]) => {
    const o = document.createElement("option");
    o.value = v; o.textContent = t; o.selected = config.theme === v;
    sel.append(o);
  });
  sel.addEventListener("change", () => setTheme(sel.value));
  row.append(l, sel);
  body.append(row);
}

function renderMidiHapticsSettings(body) {
  const title = document.createElement("div");
  title.className = "set-group-title";
  title.textContent = "MIDI & Haptics";
  body.append(title);

  // Haptics toggle
  const hRow = document.createElement("label"); hRow.className = "set-row";
  const hL = document.createElement("span");
  hL.textContent = hapticsSupported() ? "Haptic feedback (vibration)" : "Haptic feedback (unsupported here)";
  const hCb = document.createElement("input"); hCb.type = "checkbox";
  hCb.checked = config.haptics; hCb.disabled = !hapticsSupported();
  hCb.addEventListener("change", () => { config.haptics = hCb.checked; setHapticsEnabled(hCb.checked); saveConfig(); });
  hRow.append(hL, hCb); body.append(hRow);

  // MIDI enable toggle
  const mRow = document.createElement("label"); mRow.className = "set-row";
  const mL = document.createElement("span"); mL.textContent = "Enable MIDI controller";
  const mCb = document.createElement("input"); mCb.type = "checkbox";
  mCb.checked = config.midi.enabled; mCb.disabled = !(midi && midi.supported());
  mCb.addEventListener("change", async () => {
    config.midi.enabled = mCb.checked; saveConfig();
    if (mCb.checked && midi) await midi.enable();
    renderSettings();
  });
  mRow.append(mL, mCb); body.append(mRow);

  // Status line
  const status = document.createElement("div"); status.className = "hint"; status.id = "midi-status";
  status.textContent = midiStatusText({ supported: !!(midi && midi.supported()), enabled: config.midi.enabled, devices: midi ? midi.devices : [] });
  body.append(status);

  // Learn rows for the mappable continuous controls
  const LEARNABLE = [
    ["crossfade", "Crossfader"], ["volA", "Deck A volume"], ["volB", "Deck B volume"],
    ["eqA", "Deck A EQ (mid)"], ["eqB", "Deck B EQ (mid)"],
    ["eqAlow", "Deck A EQ (low)"], ["eqAhigh", "Deck A EQ (high)"],
    ["eqBlow", "Deck B EQ (low)"], ["eqBhigh", "Deck B EQ (high)"],
    ["trimA", "Deck A trim"], ["trimB", "Deck B trim"],
    ["filterA", "Deck A filter"], ["filterB", "Deck B filter"],
    ["jogA", "Deck A jog/scratch"], ["jogB", "Deck B jog/scratch"],
    // Button actions — press a PAD/NOTE while learning to bind these:
    ["playA", "Deck A play/pause"], ["playB", "Deck B play/pause"],
    ["cueA", "Deck A cue"], ["cueB", "Deck B cue"],
    ["syncA", "Deck A sync"], ["syncB", "Deck B sync"],
    ["loopA", "Deck A auto-loop"], ["loopB", "Deck B auto-loop"],
  ];
  for (const [action, label] of LEARNABLE) {
    const row = document.createElement("div"); row.className = "set-row";
    const l = document.createElement("span");
    const m = config.midi.map[action];
    const bound = m?.cc != null ? `CC ${m.cc}` : m?.note != null ? `note ${m.note}` : "—";
    l.textContent = `${label} — ${bound}`;
    const b = document.createElement("button");
    b.className = "key-btn" + (midiLearn === action ? " capturing" : "");
    b.textContent = midiLearn === action ? "move a control…" : "Learn";
    b.addEventListener("click", () => { midiLearn = midiLearn === action ? null : action; renderSettings(); });
    row.append(l, b); body.append(row);
  }
}

function setupSettings() {
  const dialog = document.getElementById("settings-dialog");
  const close = () => { rebindCapture = null; dialog.hidden = true; };
  document.getElementById("settings-btn").addEventListener("click", () => { rebindCapture = null; renderSettings(); dialog.hidden = false; });
  document.getElementById("settings-close").addEventListener("click", close);
  document.getElementById("settings-reset").addEventListener("click", () => {
    Object.assign(config.keys, DEFAULT_KEYS);
    Object.assign(config.gestures, DEFAULT_GESTURES);
    rebuildKeyMap(); saveConfig();
    engine.crossfadeCurve = config.gestures.crossfadeCurve ?? "power";
    engine.hamster = config.gestures.hamsterMode ?? false;
    engine.setCrossfade(engine.crossfade);
    renderSettings();
    if (sampler) renderPads();
    ui.toast("Controls reset to defaults");
  });
  dialog.addEventListener("click", (e) => { if (e.target === dialog) close(); });
}

// ---------- Web MIDI controllers ----------
function setupMidi() {
  setHapticsEnabled(config.haptics);
  midi = new MidiInput();
  midi.onStatus = (info) => {
    const el = document.getElementById("midi-status");
    if (el) el.textContent = midiStatusText(info);
  };
  midi.onControl = (cc, value) => handleMidiCC(cc, value);
  midi.onNote = (note, vel, ch, on) => handleMidiNote(note, vel, on);
  midi.onPitchBend = (bend) => handleMidiPitchBend(bend);
  if (config.midi.enabled && midi.supported()) {
    // The user previously enabled MIDI: if it can't start now (permission
    // revoked, device gone), SAY so instead of silently doing nothing.
    midi.enable().then((ok) => {
      if (!ok) ui.toast("MIDI couldn't start — check browser permissions in ⚙ Settings", { severity: "error" });
    });
  }
}

function midiStatusText(info) {
  if (!info.supported) return "Web MIDI not supported in this browser";
  if (!info.enabled) return "MIDI off";
  return info.devices.length ? `Connected: ${info.devices.join(", ")}` : "No MIDI device detected";
}

function handleMidiCC(cc, value) {
  // MIDI Learn: bind the next incoming CC to the pending action.
  if (midiLearn) {
    config.midi.map[midiLearn] = { cc };
    midiLearn = null;
    saveConfig();
    if (!document.getElementById("settings-dialog").hidden) renderSettings();
    ui.toast(`Mapped CC ${cc}`);
    return;
  }
  const map = config.midi.map;
  if (map.jogA && map.jogA.cc === cc) return midiJog("A", value);
  if (map.jogB && map.jogB.cc === cc) return midiJog("B", value);
  // Generic dispatch: any mapped action with an on-screen target responds —
  // covers crossfade/volumes and every channel knob without a hardcoded list.
  for (const [action, m] of Object.entries(map)) {
    if (m && m.cc === cc && midiTargets[action]) { midiTargets[action](value); return; }
  }
}

// A relative jog wheel sends 1..63 forward / 65..127 backward; treat each
// message as a momentary scratch nudge that releases after a short idle.
function midiJog(deck, value01) {
  const raw = Math.round(value01 * 127);
  const signed = raw === 0 ? 0 : raw < 64 ? raw : raw - 128;
  const d = engine.decks[deck], st = midiJogState[deck];
  if (!st.active) { d.touchStart(); st.active = true; }
  d.jog(signed * 0.3);
  clearTimeout(st.timer);
  st.timer = setTimeout(() => { d.touchEnd(); st.active = false; }, 100);
}

function handleMidiNote(note, vel, on) {
  if (document.body.classList.contains("view-studio")) {
    DAW.midiNote?.(note, vel, on);
    return;
  }
  if (!on) return;
  // MIDI Learn also accepts a NOTE (pads/buttons) for the pending action.
  if (midiLearn) {
    config.midi.map[midiLearn] = { note };
    midiLearn = null;
    saveConfig();
    if (!document.getElementById("settings-dialog").hidden) renderSettings();
    ui.toast(`Mapped note ${note}`);
    return;
  }
  // Note-mapped transport (play/cue/sync/loop per deck, bound via MIDI Learn).
  for (const [action, m] of Object.entries(config.midi.map)) {
    if (m && m.note === note) {
      const fn = buildActions()[action];
      if (fn) { fn({ shiftKey: false }); return; } // hot-cue actions read e.shiftKey
    }
  }
  // Notes 36..43 -> sampler pads 1..8 (the common finger-drum / pad range),
  // velocity-sensitive.
  if (note >= 36 && note <= 43) triggerSample(note - 36, vel);
}

// Pitch-bend wheel/buttons: a momentary ±8% rate push on the toolbar-active
// deck that springs back on release — the classic beat-matching nudge. Applied
// as a temporary worklet rate (the tempo fader state is untouched).
function handleMidiPitchBend(bend) {
  const shell = document.querySelector(".controller-shell");
  const deck = shell?.dataset.activeDeck === "B" ? "B" : "A";
  const d = engine.decks[deck];
  const base = 1 + d.tempo / 100;
  const pushed = Math.abs(bend) < 0.02 ? base : base * (1 + bend * 0.08);
  d.node.port.postMessage({ type: "rate", value: pushed });
}

// ---------- Practice mode ----------
function loadPracticeBeat(deck, bpm) {
  const buf = makeBeat(engine.ctx, bpm, 24);
  applyLoaded(deck, buf, `practice • ${bpm} BPM`, { bpm }); // known tempo → live readout + beat-accurate auto-loop
  return buf;
}

// ---------- Loops + Beat FX ----------
function toggleAutoLoop(deck) {
  const d = engine.decks[deck];
  if (d.loop && d.loop.active) d.loopExit();
  else d.autoLoop(4);
}

function setupLoopsFx() {
  const onDeck = (sel, fn) =>
    document.querySelectorAll(sel).forEach((b) => b.addEventListener("click", () => fn(engine.decks[b.dataset.deck], b.dataset.deck)));
  onDeck(".loop-auto", (_, id) => toggleAutoLoop(id));
  onDeck(".loop-in", (d) => d.loopIn());
  onDeck(".loop-out", (d) => d.loopOut());
  onDeck(".loop-half", (d) => d.loopHalve());
  onDeck(".loop-double", (d) => d.loopDouble());
  onDeck(".loop-exit", (d) => d.loopExit());

  // Loop to sampler pad mapping setup
  document.querySelectorAll(".loop-to-pad").forEach((btn) => {
    const deckId = btn.dataset.deck;
    btn.addEventListener("click", () => {
      const d = engine.decks[deckId];
      if (!d.buffer) {
        ui.toast("Load a track first");
        return;
      }
      if (d.loop.start < 0 || d.loop.end <= d.loop.start) {
        ui.toast("Set loop IN and OUT first to define a region");
        return;
      }

      // Toggle mapping mode
      if (mappingSource && mappingSource.deckId === deckId) {
        cancelMappingMode();
      } else {
        enterMappingMode(deckId, d.loop.start, d.loop.end, btn);
      }
    });
  });

  // Brake = momentary (hold). Spin = one-shot.
  document.querySelectorAll(".fx-brake").forEach((b) => {
    const d = engine.decks[b.dataset.deck];
    const on = (e) => { e.preventDefault(); d.brake(true); b.classList.add("held"); };
    const off = () => { d.brake(false); b.classList.remove("held"); };
    b.addEventListener("pointerdown", on);
    b.addEventListener("pointerup", off);
    b.addEventListener("pointerleave", off);
    b.addEventListener("pointercancel", off);
  });
  document.querySelectorAll(".fx-spin").forEach((b) =>
    b.addEventListener("click", () => engine.decks[b.dataset.deck].backspin())
  );

  // Independent Beat FX per deck
  document.querySelectorAll(".fx-btn").forEach((b) => {
    const deck = b.dataset.deck;
    b.addEventListener("click", () => {
      const d = engine.decks[deck];
      d.fx.select(b.dataset.fx);
      document.querySelectorAll(`.fx-btn[data-deck="${deck}"]`).forEach((x) => x.classList.toggle("active", x === b));
    });
  });

  document.querySelectorAll(".fx-depth-slider").forEach((slider) => {
    const deck = slider.dataset.deck;
    const d = engine.decks[deck];
    d.fx.setDepth(parseFloat(slider.value));
    slider.addEventListener("input", () => d.fx.setDepth(parseFloat(slider.value)));
  });

  document.querySelectorAll(".fx-on").forEach((btn) => {
    const deck = btn.dataset.deck;
    const d = engine.decks[deck];
    btn.addEventListener("click", () => {
      d.fx.setOn(!d.fx.on);
      btn.classList.toggle("active", d.fx.on);
    });
  });
}

// Practice-mode adapter over the shared mix recorder (js/recorder.js): the
// coach expects { start(), stop(cb → objectURL|null) }. Failures surface as a
// toast instead of silently producing no routine playback.
function makeRecorder() {
  const recorder = createMixRecorder(engine);
  if (!recorder) return null;
  recorder.onerror = (msg) => ui.toast(msg);
  return {
    start() {
      if (!recorder.start()) ui.toast("Routine recording unavailable — playback won't be offered");
    },
    stop(cb) {
      recorder.stop().then((r) => cb?.(r ? URL.createObjectURL(r.blob) : null));
    },
  };
}

function setupPractice() {
  coach = new PracticeCoach({ engine, ui, loadBeat: loadPracticeBeat });
  coach.recorder = makeRecorder();
  engine.onJog = (id, rate) => coach.onJog(id, rate);
  // (crossfade instrumentation rides the fan-out registered in setup())

  const dialog = document.getElementById("practice-dialog");
  const list = document.getElementById("practice-list");
  const cats = [];
  for (const l of LESSONS) {
    let grp = cats.find((c) => c.cat === l.cat);
    if (!grp) { grp = { cat: l.cat, items: [] }; cats.push(grp); }
    grp.items.push(l);
  }
  list.innerHTML = "";
  // Freestyle (scored) sits at the top.
  const fcat = document.createElement("div"); fcat.className = "practice-cat"; fcat.textContent = "Freestyle";
  list.append(fcat);
  const fbtn = document.createElement("button");
  fbtn.className = "lesson-btn freestyle-btn";
  fbtn.innerHTML = `<span class="lesson-title">🔥 Freestyle — 30 seconds</span><span class="lesson-blurb">Go off on both decks; get scored, ranked and coached.</span>`;
  fbtn.addEventListener("click", () => { dialog.hidden = true; coach.startFreestyle(); });
  list.append(fbtn);

  for (const grp of cats) {
    const h = document.createElement("div"); h.className = "practice-cat"; h.textContent = grp.cat;
    list.append(h);
    for (const l of grp.items) {
      const b = document.createElement("button");
      b.className = "lesson-btn";
      b.innerHTML = `<span class="lesson-title">${l.title}</span><span class="lesson-blurb">${l.blurb}</span>`;
      b.addEventListener("click", () => { dialog.hidden = true; coach.start(l.id); });
      list.append(b);
    }
  }
  document.getElementById("practice-btn").addEventListener("click", () => (dialog.hidden = false));
  document.getElementById("practice-close").addEventListener("click", () => (dialog.hidden = true));
  dialog.addEventListener("click", (e) => { if (e.target === dialog) dialog.hidden = true; });
}

// ---------- SXRATCH / PAD navigation ----------
let studioReady = false;
function showView(view) {
  const studio = view === "studio";
  // A coach mark anchored to the other view is no longer useful, and would
  // otherwise overlap the Studio's resumable tour.
  activeQuickTourEnd?.();
  document.body.classList.toggle("view-studio", studio);
  // Keep the REAL hidden attributes truthful: two <main>s are only valid when
  // at most one is non-hidden. (#console's visual hiding is the CSS class —
  // its author display rules would beat the hidden attribute anyway.)
  document.getElementById("studio").hidden = !studio;
  document.getElementById("console").hidden = studio;
  const skip = document.getElementById("skip-link");
  if (skip) skip.href = studio ? "#studio" : "#console";
  const navDecks = document.getElementById("nav-decks");
  const navStudio = document.getElementById("nav-studio");
  navDecks.classList.toggle("active", !studio);
  navStudio.classList.toggle("active", studio);
  if (studio) { navStudio.setAttribute("aria-current", "page"); navDecks.removeAttribute("aria-current"); }
  else { navDecks.setAttribute("aria-current", "page"); navStudio.removeAttribute("aria-current"); }
  if (studio) {
    if (!studioReady) {
      studioReady = true;
      const studioInit = DAW.init({
        getCtx: () => engine.ctx,
        getOutput: () => engine.masterBus,
        toast: (m, o) => ui.toast(m, o),
        onUse: (buf, label, deck, bpm, sectionCues) => {
          // PAD knows its own tempo — carry it onto the deck so the BPM
          // readout, SYNC and auto-loops are correct for your composition.
          applyLoaded(deck, buf, label, { bpm: bpm || null, detect: !bpm });
          // Drop a hot cue at each section boundary so the arrangement is
          // instantly navigable on the deck (slots 1..8).
          if (Array.isArray(sectionCues) && sectionCues.length) {
            sectionCues.slice(0, HOT_CUE_COUNT).forEach((pos, i) => {
              if (pos > 0 && pos < 1) hot[deck][i] = pos;
              else if (pos === 0) hot[deck][i] = 0;
            });
            renderHot(deck);
          }
          showView("decks");
        },
        getSampler: () => sampler,
      });
      Promise.resolve(studioInit).then(() => DAW.maybeStartTour?.());
    }
    else DAW.maybeStartTour?.();
  } else {
    DAW.stopPreview();
  }
  window.dispatchEvent(new Event("resize"));
}
function setupNav() {
  document.getElementById("nav-decks").addEventListener("click", () => showView("decks"));
  document.getElementById("nav-studio").addEventListener("click", () => showView("studio"));
}

// ---------- Dialogs ----------
function setupDialogs() {
  const help = document.getElementById("help-dialog");
  const helpKeys = document.getElementById("help-keys");
  // The bindings section is generated from the live config so it can never
  // drift from what the keys actually do (unlike hand-written help text).
  const fillHelpKeys = () => {
    if (!helpKeys) return;
    let html = '<div class="set-group-title">Your key bindings</div><div class="help-keys-grid">';
    for (const [, rows] of KEY_ACTION_GROUPS) {
      for (const [name, label] of rows) {
        html += `<span>${label}</span><kbd>${fmtKey(config.keys[name])}</kbd>`;
      }
    }
    html += "</div>";
    helpKeys.innerHTML = html;
  };
  const openHelp = () => {
    fillHelpKeys();
    help.hidden = false;
    document.getElementById("help-close")?.focus();
  };
  document.getElementById("help-btn").addEventListener("click", openHelp);
  document.getElementById("help-close").addEventListener("click", () => (help.hidden = true));
  [help, document.getElementById("url-dialog")].forEach((d) =>
    d.addEventListener("click", (e) => { if (e.target === d) d.hidden = true; })
  );

  // "?" opens the cheat sheet; Esc closes whichever dialog is open.
  window.addEventListener("keydown", (e) => {
    if (e.target.closest && e.target.closest("input, textarea, select")) return;
    if (e.key === "?" && help.hidden) { openHelp(); e.preventDefault(); return; }
    if (e.code === "Escape") {
      for (const id of ["help-dialog", "url-dialog", "settings-dialog", "practice-dialog", "projects-dialog", "section-sheet"]) {
        const d = document.getElementById(id);
        if (d && !d.hidden) { d.hidden = true; e.preventDefault(); return; }
      }
    }
  });
}

// ---------- Waveform zoom ----------
function setupWaveTools() {
  document.querySelectorAll(".zoom-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const wave = ui.waves[btn.dataset.deck];
      wave.zoomBy(btn.dataset.dir === "in" ? 1.5 : 1 / 1.5);
    });
  });
}

// ---------- Hot cues ----------
function setupHotcues() {
  for (const id of ["A", "B"]) {
    const wrap = document.querySelector(`.hotcues[data-deck="${id}"]`);
    wrap.innerHTML = "";
    for (let i = 0; i < HOT_CUE_COUNT; i++) {
      const chip = document.createElement("button");
      chip.className = "hotcue-chip";
      chip.dataset.deck = id;
      chip.dataset.slot = String(i);
      chip.textContent = String(i + 1);
      chip.title = "Click: set / jump · double-click or Shift-click: clear";
      chip.addEventListener("click", (e) => {
        if (e.shiftKey) clearCue(id, i);
        else hitCue(id, i);
      });
      // Double-click = clear, matching the app-wide reset gesture (faders,
      // knobs and waveform cue markers all already clear on double-click).
      chip.addEventListener("dblclick", (e) => { e.preventDefault(); clearCue(id, i); });
      wrap.appendChild(chip);
    }
    renderHot(id);
  }
}

/** Set a cue if the slot is empty, otherwise jump to it. */
function hitCue(id, slot) {
  if (hot[id][slot] == null) setCueSlot(id, slot, engine.decks[id].position);
  else engine.decks[id].seek(hot[id][slot]);
  coach?.notify("hotcue");
}

function setCueSlot(id, slot, pos) {
  if (!engine.decks[id].duration) return;
  hot[id][slot] = pos;
  renderHot(id);
  haptic(12);
  ui.toast(`Deck ${id}: hot cue ${slot + 1} set`);
}

function clearCue(id, slot) {
  hot[id][slot] = null;
  renderHot(id);
}

function renderHot(id) {
  const cues = [];
  hot[id].forEach((p, i) => {
    if (p != null) cues.push({ pos: p, color: CUE_COLORS[i], label: i + 1 });
  });
  ui.waves[id]?.setCues(cues);
  document.querySelectorAll(`.hotcue-chip[data-deck="${id}"]`).forEach((chip) => {
    const slot = Number(chip.dataset.slot);
    const set = hot[id][slot] != null;
    chip.classList.toggle("set", set);
    chip.style.background = set ? CUE_COLORS[slot] : "";
  });
}

// ---------- Animation loop: VU meters + platter rotation ----------
/** RMS → meter height %, linear in dB from −30 dBFS (bottom) to 0 dBFS (top),
 *  matching the printed scale beside the centre meters. */
function vuPercent(rms) {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.max(0, Math.min(100, ((db + 30) / 30) * 100));
}

function frameLoop() {
  const now = performance.now();
  if (coach) coach.update();
  if (bothBtn) bothBtn.classList.toggle("playing", engine.decks.A.playing && engine.decks.B.playing);

  // Live master output meter (with a slowly-decaying peak-hold cap).
  if (masterAnalyser && masterVuEl) {
    masterAnalyser.getFloatTimeDomainData(masterBuf);
    let sum = 0;
    for (let i = 0; i < masterBuf.length; i++) sum += masterBuf[i] * masterBuf[i];
    const lvl = vuPercent(Math.sqrt(sum / masterBuf.length));
    masterPeak = Math.max(lvl, masterPeak - 0.7);
    masterVuEl.style.setProperty("--level", lvl.toFixed(1) + "%");
    masterVuEl.style.setProperty("--peak", Math.min(99, masterPeak).toFixed(1) + "%");
  }

  for (const id of ["A", "B"]) {
    // VU (dB-calibrated so the printed scale next to it is honest)
    const a = analysers[id];
    if (a) {
      a.node.getFloatTimeDomainData(a.buf);
      let sum = 0;
      for (let i = 0; i < a.buf.length; i++) sum += a.buf[i] * a.buf[i];
      const lvl = vuPercent(Math.sqrt(sum / a.buf.length));
      a.peak = Math.max(lvl, (a.peak || 0) - 0.8);
      a.el.style.setProperty("--level", lvl + "%");
      a.el.style.setProperty("--peak", Math.min(99, a.peak).toFixed(1) + "%");
    }

    // Platter rotation — extrapolate the playhead since the last position post
    // so the disc spins smoothly (and reverses while scratching).
    const deck = engine.decks[id];
    const r = rot[id];
    if (deck.duration > 0) {
      let dt = (now - r.t) / 1000;
      if (dt > 0.25) dt = 0; // tab was backgrounded; don't lurch
      const est = Math.max(0, Math.min(1, r.pos + (r.rate / deck.duration) * dt));
      const seconds = est * deck.duration;
      discs[id].style.transform = `rotate(${seconds * DEG_PER_SEC}deg)`;
      // Scroll the waveform off the same extrapolated playhead so it tracks the
      // platter at full frame rate (the worklet only posts position ~25/s).
      ui.waves[id]?.setPosition(est);
    } else {
      discs[id].style.transform = "rotate(0deg)";
    }

    // Flush any pending waveform redraw (cues/loops/scroll) once per frame.
    ui.waves[id]?.renderIfDirty();

    // Update split real-time FFT visualizer per deck
    drawDeckVisualizer(id);
  }
  requestAnimationFrame(frameLoop);
}

function drawDeckVisualizer(id) {
  const canvas = document.getElementById(`viz-${id}`);
  if (!canvas || !engine.ready) return;
  if (!canvas.clientWidth) return; // hidden (e.g. inside the controller shell) — don't burn frames
  const d = engine.decks[id];
  if (!d || !d.analyser) return;

  // Reuse the canvas context + frequency buffer across frames (allocating a
  // fresh Uint8Array every frame, x2 decks x60fps, was steady GC pressure).
  let v = vizCache[id];
  if (!v || v.canvas !== canvas) {
    v = vizCache[id] = { canvas, ctx: canvas.getContext("2d"), buf: new Uint8Array(d.analyser.frequencyBinCount) };
  }
  const ctx = v.ctx;
  const dataArray = v.buf;
  d.analyser.getByteFrequencyData(dataArray);

  // Clear canvas
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const w = canvas.width;
  const h = canvas.height;
  const midX = w / 2;

  // Symmetrical frequency bars growing outward from the center
  const barCount = 16;
  const barGap = 2;
  const totalBarWidth = (w / 2) / barCount;
  const barWidth = totalBarWidth - barGap;

  for (let i = 0; i < barCount; i++) {
    const val = dataArray[i]; // 0..255
    const percent = val / 255;
    const barHeight = Math.max(2, percent * h * 0.9);

    // Deck-coloured bars, fading toward the outer edge. Reads the theme
    // token rather than a hardcoded hue (65% lightness was invisible on
    // a light stage).
    ctx.fillStyle = DECK_COLORS[id];
    ctx.globalAlpha = 0.9 - (i / barCount) * 0.45;

    // Draw left half (moving left from center)
    const lx = midX - (i * totalBarWidth) - totalBarWidth;
    ctx.fillRect(lx, h - barHeight, barWidth, barHeight);

    // Draw right half (moving right from center)
    const rx = midX + (i * totalBarWidth);
    ctx.fillRect(rx, h - barHeight, barWidth, barHeight);
  }
  ctx.globalAlpha = 1;
}

function enterMappingMode(deckId, start, end, btn) {
  cancelMappingMode(); // cancel any active mapping first
  
  mappingSource = { deckId, start, end };
  btn.classList.add("active");
  
  // Highlight all sampler pads to indicate they are targets
  document.querySelectorAll(".samp-pad").forEach((pad) => {
    pad.classList.add("mappable");
  });
  
  ui.toast(`Tap a sampler pad (1–8) to map the Deck ${deckId} loop region`);
}

function cancelMappingMode() {
  mappingSource = null;
  document.querySelectorAll(".loop-to-pad").forEach((btn) => btn.classList.remove("active"));
  document.querySelectorAll(".samp-pad").forEach((pad) => pad.classList.remove("mappable"));
}

function mapRegionToPad(deckId, start, end, slotIndex) {
  const d = engine.decks[deckId];
  if (!d || !d.buffer) return;

  try {
    const slicedBuffer = extractAudioRegion(engine.ctx, d.buffer, start, end);
    const sliceName = `${d.name || "Track"} [Slice]`;
    sampler.setBuffer(slotIndex, slicedBuffer, sliceName);
    renderPad(slotIndex);
    ui.toast(`Mapped Deck ${deckId} region to pad ${slotIndex + 1}`, { severity: "ok" });
  } catch (err) {
    console.error(err);
    ui.toast("Couldn't extract the loop region", { severity: "error" });
  }
}

function extractAudioRegion(ctx, sourceBuffer, startFraction, endFraction) {
  const sampleRate = sourceBuffer.sampleRate;
  const numChannels = sourceBuffer.numberOfChannels;
  const len = sourceBuffer.length;
  
  // Calculate sample indices from normalized fractions (0..1)
  const start = Math.max(0, Math.min(len - 1, Math.round(startFraction * len)));
  const end = Math.max(start + 1, Math.min(len, Math.round(endFraction * len)));
  const newLength = end - start;
  
  // Create a new AudioBuffer
  const newBuffer = ctx.createBuffer(numChannels, newLength, sampleRate);
  
  // Copy channel data
  for (let c = 0; c < numChannels; c++) {
    const srcData = sourceBuffer.getChannelData(c);
    const destData = newBuffer.getChannelData(c);
    destData.set(srcData.subarray(start, end));
  }

  return newBuffer;
}
// (Phase 1 polish: live BPM + master metering + A|B toolbar switch — see DESIGN-REVIEW.md)
