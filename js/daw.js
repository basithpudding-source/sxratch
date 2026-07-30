// PAD Studio — DAW-style arrangement view.
//
// Ground-up replacement for the section-based song builder: a track/region
// timeline with a transport, live multitrack recording (audio input AND
// MIDI/keyboard capture), per-track device chains, a virtual keyboard and a
// piano-roll region editor. The realtime playback/recording engine lives in
// js/daw-engine.js; this module owns the song model, all UI, persistence,
// undo and the deck/export integrations.
//
// Model (beats; 1 beat = quarter note):
//   song = { v, bpm, ts:{num,den}, loop:{on,a,b}, tracks:[Track] }
//   Track = { id, name, kind:'midi'|'drums'|'audio', color, family?, sound?,
//             kit?, gain, pan, mute, solo, armed, inputId?, fx:{eq,reverb},
//             regions:[Region] }
//   Region midi  = { id, name, start, len, notes:[{b,d,m,v}] }
//   Region drums = { id, name, start, len, hits:[{b,k,v}] }
//   Region audio = { id, name, start, len, clipId, offset, gain }
// Audio clip buffers live OUTSIDE the model in `clips` (id → AudioBuffer),
// persisted to IndexedDB, so undo snapshots stay small.

import { createDawEngine, DRUM_KEYS } from "./daw-engine.js";
import { FACTORY_PATCHES } from "./synth.js";
import { bufferToWav } from "./wav.js";
import { encodeMidi } from "./midiexport.js";
import { readVersioned, writeVersioned } from "./store.js";
import { saveSample, loadAllSamples, deleteSample } from "./idb-store.js";
import {
  DEFAULT_SNAP,
  MIN_SNAP,
  SNAP_OPTIONS,
  clampFinite,
  duplicateRegion,
  formatMusicalPosition,
  nearestSnap,
  quantizeBeat,
  splitRegionContent,
  trimRegionStartContent,
  quantizeRegionNotes,
  transposeRegionNotes,
} from "./daw-model.js";

export const DAW = (() => {
  /* ---------------- deps (from app.js) ---------------- */
  let _getCtx = () => { throw new Error("DAW not initialised"); };
  let _toast = () => {};
  let _onUse = () => {};
  let _getSampler = () => null;

  /* ---------------- constants ---------------- */
  const STORE_KEY = "sxratch.daw";
  const SCHEMA_V = 2;
  const MIGRATIONS = [
    (s) => s,
    (s) => ({ ...s, view: { snap: DEFAULT_SNAP, zoom: 26, follow: true, ...(s?.view || {}) } }),
  ];
  const CLIP_PREFIX = "dawclip:";
  const LANE_H = 68;        // must match .daw-lane / .daw-head heights in daw.css
  const PREVIEW_H = 34;     // must match .daw-region-cv height in daw.css
  const MAJOR = [0, 2, 4, 5, 7, 9, 11, 12];
  const DRUM_LABELS = { crash: "Crash", hat: "Hi-Hat", open: "Open Hat", snare: "Snare", tomH: "Tom Hi", tomM: "Tom Mid", tomL: "Tom Low", kick: "Kick" };
  const KIT_LABELS = {
    acoustic: "Acoustic kit",
    "808": "808 / Hip-hop",
    electronic: "Electronic",
    bossa: "Bossa / Brushes",
    lofi: "Lo-Fi",
    "909": "909 Techno",
    trap: "Hard Trap & Drill",
    synthwave: "80s Synthwave",
    afrobeats: "Afrobeats & Amapiano",
    indie: "Indie Rock",
  };
  const SOUND_LABELS = {
    chord: {
      pad: "Warm analog pad",
      strings: "Symphonic strings",
      epiano: "Vintage E-piano",
      organ: "Hammond B3 organ",
      guitar: "Acoustic steel guitar",
      grand_piano: "Concert grand piano",
      clavinet: "Funk clavinet",
      brass_section: "Orchestral brass",
      supersaw_pad: "7-Voice supersaw pad",
      glass_keys: "Crystal glass keys",
    },
    bass: {
      electric: "Vintage precision bass",
      synth: "Moog mini bass",
      upright: "Jazz upright bass",
      sub: "808 Sub sine",
      acid_tb: "Acid 303 bass",
      slap_bass: "Funk slap bass",
      wobble_bass: "Dubstep wobble bass",
      fm_lately: "FM Lately bass",
    },
    lead: {
      synth: "Classic saw lead",
      square: "Chiptune square lead",
      flute: "Concert flute lead",
      bell: "Crystal tubular bell",
      guitar: "Plucked lead guitar",
      supersaw_lead: "Super saw lead",
      soft_lead: "Warm solo lead",
      brass_lead: "Synth brass lead",
      whistle: "Synth whistle",
    },
    chorus: {
      choir_vox: "Vocal choir ensemble",
      warm_chorus: "Stereo chorus pad",
      ambient_space: "Cinematic space sweep",
      celestial: "Celestial bell choir",
      lush_strings: "Chamber string ensemble",
    },
  };
  const TRACK_COLORS = ["var(--sx-lane-bass)", "var(--sx-lane-chords)", "var(--sx-brand-b)", "var(--sx-hot)", "var(--sx-lane-drums)", "var(--sx-purple)"];
  const DEFAULT_FX = () => ({
    eq: { on: true, hp: 20, peakF: 1000, peakG: 0, peakQ: 0.9, lp: 20000 },
    reverb: { on: true, size: 0.4, damp: 0.5, mix: 0 },
    compressor: { on: false, thresh: -24, ratio: 4, attack: 0.01, release: 0.25 },
    delay: { on: false, time: 0.25, feedback: 0.3, mix: 0 },
    distortion: { on: false, drive: 0.2, mix: 0.5 },
  });
  // QWERTY → semitone offsets (A to L for white notes, W E T Y U O P for black notes).
  const QWERTY = {
    KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16, Quote: 17,
    KeyQ: 0, Digit2: 1, Digit3: 3, KeyR: 5, Digit5: 6, Digit6: 8, Digit7: 10, KeyI: 12, Digit9: 13, Digit0: 15,
  };
  const SEMI_TO_LABEL = {
    0: "A", 1: "W", 2: "S", 3: "E", 4: "D", 5: "F", 6: "T", 7: "G", 8: "Y", 9: "H", 10: "U", 11: "J", 12: "K", 13: "O", 14: "L", 15: "P", 16: ";", 17: "'",
  };
  const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const keyName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);

  /* ---------------- state ---------------- */
  let song = null;
  let clips = new Map();                   // clipId → AudioBuffer
  let engine = null;
  let root = null;                         // #song-builder
  let el_ = {};                            // named DOM handles
  let idc = 1;
  let activeTrackId = null;
  let selRegion = null;                    // { trackId, regionId }
  let editRegion = null;                   // region open in the piano roll
  let tool = "select";
  let pxPerBeat = 26;
  let snapStep = DEFAULT_SNAP;
  let followPlayhead = true;
  let octave = 4;                          // virtual keyboard base octave (C4=60)
  // One bottom panel at a time (editor | keys | chain | null=collapsed) with a
  // user-draggable height — the timeline owns whatever is left. `prev` is the
  // last non-editor panel so closing the editor restores it.
  const PANELS_KEY = "sxratch.dawpanels";
  const BOTTOM_MIN = 132, BOTTOM_DEF = 156, BOTTOM_MAX = 480;
  let bottom = { active: "keys", h: BOTTOM_DEF, prev: "keys", reopen: null };
  let heldKeys = new Map();                // code → {trackId, midi, tOn}
  let inputDevices = [];
  let rafId = null;
  let undoStack = [], redoStack = [], undoBytes = 0;
  const UNDO_BUDGET = 6 * 1024 * 1024;
  let _saveTimer = null;

  const $ = (s) => root.querySelector(s);
  const beatsPerBar = () => (song.ts.num * 4) / song.ts.den;
  const activeTrack = () => song.tracks.find((t) => t.id === activeTrackId) || song.tracks[0] || null;
  const trackById = (id) => song.tracks.find((t) => t.id === id);
  const regionById = (t, id) => t && (t.regions || []).find((r) => r.id === id);
  const songEnd = () => Math.max(
    8 * beatsPerBar(),
    ...song.tracks.flatMap((t) => (t.regions || []).map((r) => r.start + r.len))
  );
  const snap = (b, mode = "round") => quantizeBeat(b, snapStep, mode);
  const snapBar = (b) => Math.round(b / beatsPerBar()) * beatsPerBar();

  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function iconBtn(cls, glyph, label) {
    const b = el("button", cls, glyph);
    b.type = "button"; b.title = label; b.setAttribute("aria-label", label);
    return b;
  }

  /* ---------------- undo / persistence ---------------- */
  function pushState() {
    _lastGesture.key = null;
    const snap_ = JSON.stringify(song);
    undoStack.push(snap_); undoBytes += snap_.length;
    while (undoStack.length > 1 && undoBytes > UNDO_BUDGET) undoBytes -= undoStack.shift().length;
    redoStack = [];
  }
  /**
   * One undo entry per human gesture: wheel bursts and held arrow keys repeat
   * many times but must not each snapshot the whole song. Same key within the
   * window = same gesture; any plain pushState in between resets it.
   */
  const GESTURE_MS = 700;
  let _lastGesture = { key: null, t: 0 };
  function pushStateGesture(key) {
    const now = performance.now();
    if (_lastGesture.key === key && now - _lastGesture.t < GESTURE_MS) {
      _lastGesture.t = now;
      return;
    }
    pushState();
    _lastGesture = { key, t: now };
  }
  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(song));
    const prev = undoStack.pop(); undoBytes -= prev.length;
    song = JSON.parse(prev);
    afterHistoryJump();
  }
  function redo() {
    if (!redoStack.length) return;
    const snap_ = JSON.stringify(song);
    undoStack.push(snap_); undoBytes += snap_.length;
    song = JSON.parse(redoStack.pop());
    afterHistoryJump();
  }
  function afterHistoryJump() {
    _lastGesture.key = null;   // a wheel right after undo must snapshot again
    idc = Math.max(idc, ...song.tracks.map((t) => t.id), ...song.tracks.flatMap((t) => t.regions.map((r) => r.id)), 0) + 1;
    if (!trackById(activeTrackId)) activeTrackId = song.tracks[0]?.id ?? null;
    selRegion = null;
    closeEditor();
    engine?.refreshTrackParams();
    renderAll();
    save();
  }
  function save() {
    clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => {
      writeVersioned(STORE_KEY, SCHEMA_V, song, {
        onQuota: () => _toast("Could not save — browser storage is full.", { severity: "error" }),
      });
    }, 250);
  }

  /* ---------------- model factories ---------------- */
  function makeTrack(kind, opts = {}) {
    const n = song ? song.tracks.length : 0;
    const base = {
      id: idc++, kind,
      name: opts.name || (kind === "audio" ? "Audio" : kind === "drums" ? "Drums" : (opts.family === "bass" ? "Bass" : opts.family === "lead" ? "Lead" : "Chords")),
      color: opts.color ?? n % TRACK_COLORS.length,
      gain: 0.9, pan: 0, mute: false, solo: false, armed: false,
      fx: DEFAULT_FX(), regions: [],
    };
    if (kind === "midi") { base.family = opts.family || "chord"; base.sound = opts.sound || Object.keys(FACTORY_PATCHES[base.family])[0]; base.patch = {}; }
    if (kind === "drums") base.kit = opts.kit || "acoustic";
    if (kind === "audio") base.inputId = null;
    return base;
  }
  function makeRegion(track, start, len, opts = {}) {
    const r = { id: idc++, name: opts.name || "New Region", start, len };
    if (track.kind === "audio") { r.clipId = opts.clipId || null; r.offset = opts.offset || 0; r.gain = 1; }
    else if (track.kind === "drums") r.hits = opts.hits || [];
    else r.notes = opts.notes || [];
    track.regions.push(r);
    return r;
  }

  function defaultSong() {
    const s = {
      v: SCHEMA_V,
      bpm: 120,
      ts: { num: 4, den: 4 },
      loop: { on: false, a: 0, b: 16 },
      view: { snap: DEFAULT_SNAP, zoom: 26, follow: true },
      tracks: [],
    };
    return s;
  }

  /**
   * Force any song-shaped object (imported JSON, old saves, hand-edits) into
   * a shape the UI and engine can safely traverse. Every load path runs
   * through here — a missing `loop` or `regions` must never throw later.
   */
  function normalizeSong(sg) {
    if (!sg || typeof sg !== "object" || !Array.isArray(sg.tracks)) return null;
    sg.bpm = clampFinite(sg.bpm, 40, 240, 120);
    if (!sg.ts || !(+sg.ts.num > 0) || !(+sg.ts.den > 0)) sg.ts = { num: 4, den: 4 };
    if (!sg.loop || typeof sg.loop !== "object") sg.loop = { on: false, a: 0, b: 16 };
    sg.loop.a = Math.max(0, +sg.loop.a || 0);
    sg.loop.b = Math.max(sg.loop.a + MIN_SNAP, +sg.loop.b || sg.loop.a + 16);
    sg.view = {
      snap: nearestSnap(sg.view?.snap),
      zoom: Math.max(6, Math.min(80, +sg.view?.zoom || 26)),
      follow: sg.view?.follow !== false,
    };
    sg.tracks = sg.tracks.filter((t) => t && typeof t === "object");
    for (const t of sg.tracks) {
      if (!["midi", "drums", "audio"].includes(t.kind)) t.kind = "midi";
      if (t.kind === "midi") {
        if (!FACTORY_PATCHES[t.family]) t.family = "chord";
        if (!FACTORY_PATCHES[t.family][t.sound]) t.sound = Object.keys(FACTORY_PATCHES[t.family])[0];
      }
      if (t.kind === "drums" && !KIT_LABELS[t.kit]) t.kit = "acoustic";
      t.id = +t.id || idc++;
      t.name = String(t.name || t.kind).slice(0, 24);
      t.color = (+t.color || 0) % TRACK_COLORS.length;
      t.gain = clampFinite(t.gain, 0, 1.4, 0.9);
      t.pan = clampFinite(t.pan, -1, 1, 0);
      t.fx = { ...DEFAULT_FX(), ...(t.fx || {}) };
      t.fx.eq = { ...DEFAULT_FX().eq, ...(t.fx.eq || {}) };
      t.fx.reverb = { ...DEFAULT_FX().reverb, ...(t.fx.reverb || {}) };
      t.fx.compressor = { ...DEFAULT_FX().compressor, ...(t.fx.compressor || {}) };
      t.fx.delay = { ...DEFAULT_FX().delay, ...(t.fx.delay || {}) };
      t.fx.distortion = { ...DEFAULT_FX().distortion, ...(t.fx.distortion || {}) };
      t.regions = (Array.isArray(t.regions) ? t.regions : []).filter((r) => r && typeof r === "object");
      for (const r of t.regions) {
        r.id = +r.id || idc++;
        r.start = Math.max(0, +r.start || 0);
        r.len = Math.max(MIN_SNAP, +r.len || MIN_SNAP);
        if (t.kind === "audio") {
          r.offset = Math.max(0, +r.offset || 0);
          r.gain = clampFinite(r.gain, 0, 4, 1);
        }
        else if (t.kind === "drums") r.hits = Array.isArray(r.hits) ? r.hits.filter((h) => h && DRUM_LABELS[h.k]) : [];
        else r.notes = Array.isArray(r.notes) ? r.notes.filter((n) => n && n.m >= 0 && n.m <= 127) : [];
      }
    }
    return sg;
  }
  function starterSong() {
    const s = defaultSong();
    song = s;
    const drums = makeTrack("drums", { color: 4 });
    const bass = makeTrack("midi", { family: "bass", color: 0 });
    const chords = makeTrack("midi", { family: "chord", color: 1 });
    s.tracks.push(chords, bass, drums);
    // A one-bar starter groove so first play makes sound immediately.
    const dr = makeRegion(drums, 0, 8, { name: "Beat" });
    for (let bar = 0; bar < 2; bar++) {
      const o = bar * 4;
      dr.hits.push({ b: o, k: "kick", v: 1 }, { b: o + 2, k: "kick", v: 1 });
      dr.hits.push({ b: o + 1, k: "snare", v: 1 }, { b: o + 3, k: "snare", v: 1 });
      for (let i = 0; i < 8; i++) dr.hits.push({ b: o + i * 0.5, k: "hat", v: i % 2 ? 0.5 : 0.9 });
    }
    const br = makeRegion(bass, 0, 8, { name: "Bassline" });
    [0, 0, 5, 7].forEach((deg, i) => br.notes.push({ b: i * 2, d: 1.5, m: 36 + deg, v: 1 }));
    const cr = makeRegion(chords, 0, 8, { name: "Chords" });
    [[48, 52, 55], [45, 48, 52], [53, 57, 60], [55, 59, 62]].forEach((ch, i) =>
      ch.forEach((m) => cr.notes.push({ b: i * 2, d: 2, m, v: 0.9 })));
    activeTrackId = chords.id;
    return s;
  }

  /* ---------------- migration from the old section builder ---------------- */
  function migrateOldSong(old) {
    try {
      if (!old || !Array.isArray(old.sections) || !old.sections.length) return null;
      const s = defaultSong();
      s.bpm = old.bpm || 120;
      song = s;
      const chords = makeTrack("midi", { family: "chord", color: 1, name: "Chords" });
      const bass = makeTrack("midi", { family: "bass", color: 0, name: "Bass" });
      const lead = makeTrack("midi", { family: "lead", color: 3, name: "Lead" });
      const drums = makeTrack("drums", { color: 4, name: "Drums" });
      s.tracks.push(chords, bass, drums, lead);
      let off = 0;
      for (const sec of old.sections) {
        const num = sec.ts?.num || 4, den = sec.ts?.den || 4, sub = sec.subdiv || 4;
        const stepB = (4 / den) / sub;                 // one step, in quarter-note beats
        const barB = num * (4 / den);
        const lenB = (sec.bars || 4) * barB;
        const nm = sec.name || sec.type || "Section";
        chords.sound = sec.chordSound || chords.sound;
        bass.sound = sec.bassSound || bass.sound;
        lead.sound = sec.leadSound || lead.sound;
        drums.kit = sec.drumKit || drums.kit;
        const cN = [], bN = [], lN = [], dH = [];
        (sec.chords || []).forEach((ch, c) => { if (ch && ch.notes) ch.notes.forEach((m) => cN.push({ b: c * stepB, d: (ch.len || 1) * stepB, m, v: 1 })); });
        (sec.bass || []).forEach((n, c) => { if (n) bN.push({ b: c * stepB, d: (n.len || 1) * stepB, m: 36 + (sec.key || 0) + MAJOR[n.r], v: 1 }); });
        (sec.lead || []).forEach((n, c) => { if (n) lN.push({ b: c * stepB, d: (n.len || 1) * stepB, m: 72 + (sec.key || 0) + MAJOR[n.r], v: 1 }); });
        Object.entries(sec.drums || {}).forEach(([k, steps]) => (steps || []).forEach((v, c) => {
          const dv = v === true ? 1 : v | 0;
          if (dv) dH.push({ b: c * stepB, k, v: dv === 2 ? 1.4 : dv === 3 ? 0.45 : 1 });
        }));
        if (cN.length) makeRegion(chords, off, lenB, { name: nm, notes: cN });
        if (bN.length) makeRegion(bass, off, lenB, { name: nm, notes: bN });
        if (lN.length) makeRegion(lead, off, lenB, { name: nm, notes: lN });
        if (dH.length) makeRegion(drums, off, lenB, { name: nm, hits: dH });
        off += lenB;
      }
      if (!lead.regions.length) s.tracks.splice(s.tracks.indexOf(lead), 1);
      activeTrackId = chords.id;
      return s;
    } catch { return null; }
  }

  function updateTimelineClock(mutator) {
    if (engine?.recording) {
      _toast("Stop recording before changing tempo or meter.", { severity: "error" });
      return false;
    }
    const wasPlaying = !!engine?.playing;
    const beat = engine?.beatNow() || 0;
    if (wasPlaying) engine.stop();
    pushState();
    mutator();
    if (wasPlaying) engine.play(beat);
    save();
    renderTimeline();
    updateTransportButtons();
    return true;
  }

  function resyncPlayback() {
    if (!engine?.playing || engine.recording) return;
    engine.seek(engine.beatNow());
  }

  /* ---------------- shell ---------------- */
  function buildShell() {
    root.innerHTML = "";
    const shell = el("div", "daw");
    shell.id = "daw";

    // --- transport bar ---
    const tp = el("div", "daw-transport");
    const time = el("div", "daw-time");
    time.id = "daw-time"; time.textContent = "0:00.00";
    const pos = el("div", "daw-pos");
    pos.id = "daw-pos"; pos.textContent = "1.1";
    const bpmWrap = el("label", "daw-bpm");
    const bpmIn = el("input"); bpmIn.type = "number"; bpmIn.min = 40; bpmIn.max = 240; bpmIn.value = song.bpm;
    bpmIn.id = "daw-bpm-in";
    bpmIn.addEventListener("change", () => {
      const v = Math.max(40, Math.min(240, +bpmIn.value || song.bpm));
      if (updateTimelineClock(() => { song.bpm = v; })) bpmIn.value = v;
      else bpmIn.value = song.bpm;
    });
    bpmWrap.append(bpmIn, el("span", "daw-dim", "bpm"));
    const sig = el("select", "daw-sig");
    sig.id = "daw-sig";
    sig.setAttribute("aria-label", "Time signature");
    for (const value of ["4/4", "3/4", "6/8", "5/4", "7/8", "12/8"]) {
      const option = el("option", null, value);
      option.value = value;
      option.selected = value === `${song.ts.num}/${song.ts.den}`;
      sig.appendChild(option);
    }
    sig.addEventListener("change", () => {
      const [num, den] = sig.value.split("/").map(Number);
      if (!updateTimelineClock(() => { song.ts = { num, den }; })) sig.value = `${song.ts.num}/${song.ts.den}`;
    });

    const toStart = iconBtn("daw-tbtn", "⏮", "To start");
    toStart.addEventListener("click", () => { engine.seek(0); updateClock(); });
    const playBtn = iconBtn("daw-tbtn daw-play", "▶", "Play / stop (Space)");
    playBtn.id = "daw-play";
    playBtn.addEventListener("click", togglePlay);
    const recBtn = iconBtn("daw-tbtn daw-rec", "●", "Record onto the armed track");
    recBtn.id = "daw-rec";
    recBtn.addEventListener("click", toggleRecord);
    const loopBtn = iconBtn("daw-tbtn", "🔁", "Loop — drag on the ruler to set the range");
    loopBtn.id = "daw-loop";
    loopBtn.setAttribute("aria-pressed", song.loop.on ? "true" : "false");
    loopBtn.addEventListener("click", () => {
      if (engine.recording) {
        _toast("Stop recording before changing the loop.", { severity: "error" });
        return;
      }
      pushState(); song.loop.on = !song.loop.on;
      loopBtn.setAttribute("aria-pressed", song.loop.on ? "true" : "false");
      loopBtn.classList.toggle("active", song.loop.on);
      resyncPlayback();
      save(); renderTimeline();
    });
    loopBtn.classList.toggle("active", song.loop.on);
    const metroBtn = iconBtn("daw-tbtn", "🕰", "Metronome");
    metroBtn.id = "daw-metro";
    metroBtn.addEventListener("click", () => {
      engine.setMetronome(!engine.metronome);
      metroBtn.classList.toggle("active", engine.metronome);
      metroBtn.setAttribute("aria-pressed", engine.metronome ? "true" : "false");
    });
    const countInBtn = iconBtn("daw-tbtn", "0️⃣", "Count-in bars before recording (0 / 1 / 2)");
    countInBtn.id = "daw-countin";
    countInBtn.setAttribute("aria-pressed", "false");
    countInBtn.addEventListener("click", () => {
      const next = (engine.countIn + 1) % 3;
      engine.setCountIn(next);
      countInBtn.textContent = next === 0 ? "0️⃣" : next === 1 ? "1️⃣" : "2️⃣";
      countInBtn.classList.toggle("active", next > 0);
      countInBtn.setAttribute("aria-pressed", next > 0 ? "true" : "false");
      _toast(next === 0 ? "Count-in off" : `${next}-bar count-in enabled`);
    });

    const tools = el("div", "daw-tools");
    tools.setAttribute("role", "group"); tools.setAttribute("aria-label", "Edit tool");
    for (const [id, glyph, label] of [["select", "⬉", "Select / move tool"], ["draw", "✏", "Draw regions tool"], ["split", "✂", "Split regions tool"]]) {
      const b = iconBtn("daw-tbtn daw-tool", glyph, label);
      b.dataset.tool = id;
      b.setAttribute("aria-pressed", tool === id ? "true" : "false");
      b.classList.toggle("active", tool === id);
      b.addEventListener("click", () => {
        tool = id;
        tools.querySelectorAll(".daw-tool").forEach((x) => {
          x.classList.toggle("active", x.dataset.tool === tool);
          x.setAttribute("aria-pressed", x.dataset.tool === tool ? "true" : "false");
        });
        $("#daw-lanes").dataset.tool = tool;
      });
      tools.appendChild(b);
    }

    const zoomOut = iconBtn("daw-tbtn", "−", "Zoom out");
    zoomOut.addEventListener("click", () => setZoom(pxPerBeat / 1.4));
    const zoomIn = iconBtn("daw-tbtn", "＋", "Zoom in");
    zoomIn.addEventListener("click", () => setZoom(pxPerBeat * 1.4));

    const undoBtn = iconBtn("daw-tbtn", "↶", "Undo (Ctrl+Z)");
    undoBtn.addEventListener("click", undo);
    const redoBtn = iconBtn("daw-tbtn", "↷", "Redo (Ctrl+Y)");
    redoBtn.addEventListener("click", redo);

    const file = el("details", "daw-file");
    const fileSum = el("summary", "daw-tbtn daw-file-sum", "⋯ File");
    fileSum.title = "Export, import, send to deck";
    const fileBody = el("div", "daw-file-body");
    const fbtn = (label, fn) => { const b = el("button", "daw-fbtn", label); b.type = "button"; b.addEventListener("click", () => { file.open = false; fn(); }); return b; };
    fileBody.append(
      fbtn("Send to Deck A", () => sendToDeck("A")),
      fbtn("Send to Deck B", () => sendToDeck("B")),
      fbtn("Bounce to Sampler Pad", bounceToSamplerPad),
      fbtn("Download Master WAV", downloadWav),
      fbtn("Export Stems (WAV)", exportStemsWav),
      fbtn("Export MIDI (.mid)", exportMidiFile),
      fbtn("Export JSON", exportJson),
      fbtn("Import JSON", importJson),
      fbtn("New song", newSong),
    );
    file.append(fileSum, fileBody);

    const kbToggle = iconBtn("daw-tbtn daw-panel-toggle", "🎹", "Show / hide the keyboard");
    kbToggle.addEventListener("click", () => toggleBottomPanel("keys"));
    const chToggle = iconBtn("daw-tbtn daw-panel-toggle", "🎛", "Show / hide the device chain");
    chToggle.addEventListener("click", () => toggleBottomPanel("chain"));

    const timingGroup = el("div", "daw-transport-group daw-transport-meta");
    timingGroup.append(time, pos, bpmWrap, sig);
    const playbackGroup = el("div", "daw-transport-group");
    playbackGroup.append(toStart, playBtn, recBtn, loopBtn, metroBtn, countInBtn);
    const editGroup = el("div", "daw-transport-group");
    editGroup.append(tools, zoomOut, zoomIn);
    const utilityGroup = el("div", "daw-transport-group daw-transport-utility");
    utilityGroup.append(undoBtn, redoBtn, file, kbToggle, chToggle);
    tp.append(timingGroup, playbackGroup, editGroup, el("span", "daw-flex"), utilityGroup);

    // --- body: track headers + timeline ---
    const body = el("div", "daw-body");
    const heads = el("div", "daw-heads");
    heads.id = "daw-heads";
    const headsTop = el("div", "daw-heads-top", "TRACKS");
    const headsScroll = el("div", "daw-heads-scroll");
    headsScroll.id = "daw-heads-scroll";
    const addWrap = el("div", "daw-addtrack");
    const addSel = el("select", "daw-add-sel");
    [["", "＋ Add track…"], ["chord", "Synth — Chords & Keys"], ["bass", "Synth — Bass"], ["lead", "Synth — Lead"], ["chorus", "Synth — Chorus / Atmosphere"], ["drums", "Drum kit"], ["audio", "Audio (record)"]]
      .forEach(([v, l]) => { const o = el("option", null, l); o.value = v; addSel.appendChild(o); });
    addSel.setAttribute("aria-label", "Add track");
    addSel.addEventListener("change", () => {
      const v = addSel.value; addSel.value = "";
      if (!v) return;
      pushState();
      const t = v === "drums" ? makeTrack("drums") : v === "audio" ? makeTrack("audio") : makeTrack("midi", { family: v });
      song.tracks.push(t);
      activeTrackId = t.id;
      engine.rebuildTrack(t.id);
      renderAll(); save();
      _toast(`Added ${t.name} track`);
    });
    addWrap.appendChild(addSel);
    heads.append(headsTop, headsScroll, addWrap);

    const tl = el("div", "daw-timeline");
    tl.id = "daw-timeline";
    const ruler = el("div", "daw-ruler"); ruler.id = "daw-ruler";
    const lanes = el("div", "daw-lanes"); lanes.id = "daw-lanes";
    lanes.dataset.tool = tool;
    const playhead = el("div", "daw-playhead"); playhead.id = "daw-playhead";
    const dropHint = el("div", "daw-drop-hint");
    dropHint.innerHTML = "<strong>Drop audio here</strong><span>or choose Draw and drag a region</span>";
    tl.append(ruler, lanes, dropHint, playhead);
    // The ruler is position:sticky in CSS; only the headers need syncing.
    tl.addEventListener("scroll", () => { headsScroll.scrollTop = tl.scrollTop; });
    body.append(heads, tl);

    // --- bottom area: resize gutter + tab strip + one active panel ---
    const editor = el("div", "daw-panel daw-editor"); editor.id = "daw-editor";
    const keys = el("div", "daw-panel daw-keys"); keys.id = "daw-keys";
    const chain = el("div", "daw-panel daw-chain"); chain.id = "daw-chain";
    const bottomWrap = el("div", "daw-bottom");
    const gutter = el("div", "daw-bottom-gutter");
    gutter.setAttribute("role", "separator");
    gutter.setAttribute("aria-orientation", "horizontal");
    gutter.setAttribute("aria-label", "Resize the bottom panel — drag, arrow keys, Enter collapses");
    gutter.tabIndex = 0;
    const tabs = el("div", "daw-bottom-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Studio bottom panel");
    for (const [id, label] of [["editor", "EDITOR"], ["keys", "KEYS"], ["chain", "DEVICES"]]) {
      const b = el("button", "daw-tab", label);
      b.type = "button";
      b.dataset.panel = id;
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => toggleBottomPanel(id));
      tabs.appendChild(b);
    }
    bottomWrap.append(gutter, tabs, editor, keys, chain);

    const status = el("div", "daw-status");
    const snapLabel = el("label", "daw-status-control");
    snapLabel.appendChild(el("span", null, "SNAP"));
    const snapSel = el("select", "daw-status-select");
    snapSel.id = "daw-snap";
    snapSel.setAttribute("aria-label", "Timeline snap");
    for (const option of SNAP_OPTIONS) {
      const o = el("option", null, option.label);
      o.value = String(option.beats);
      o.selected = option.beats === snapStep;
      snapSel.appendChild(o);
    }
    snapSel.addEventListener("change", () => {
      snapStep = nearestSnap(+snapSel.value);
      song.view.snap = snapStep;
      renderAll();
      save();
    });
    snapLabel.appendChild(snapSel);
    const zoomRead = el("output", "daw-status-read");
    zoomRead.id = "daw-zoom-read";
    const followBtn = iconBtn("daw-status-btn", "FOLLOW", "Follow the playhead");
    followBtn.id = "daw-follow";
    followBtn.addEventListener("click", () => {
      followPlayhead = !followPlayhead;
      song.view.follow = followPlayhead;
      syncStatus();
      save();
    });
    const selectionRead = el("span", "daw-status-selection", "No region selected");
    selectionRead.id = "daw-selection-read";
    const quantizeBtn = iconBtn("daw-status-btn", "QUANTIZE", "Quantize selected region (Q)");
    quantizeBtn.id = "daw-quantize";
    quantizeBtn.addEventListener("click", quantizeSelected);
    const duplicateBtn = iconBtn("daw-status-btn", "DUPLICATE", "Duplicate selected region (Ctrl+D)");
    duplicateBtn.id = "daw-duplicate";
    duplicateBtn.addEventListener("click", duplicateSelected);
    const deleteBtn = iconBtn("daw-status-btn daw-status-danger", "DELETE", "Delete selected region");
    deleteBtn.id = "daw-delete";
    deleteBtn.addEventListener("click", deleteSelected);
    const audioRead = el("span", "daw-status-audio", "Audio ready");
    audioRead.id = "daw-audio-read";
    status.append(snapLabel, zoomRead, followBtn, selectionRead, quantizeBtn, duplicateBtn, deleteBtn, audioRead);

    shell.append(tp, body, bottomWrap, status);
    root.appendChild(shell);
    el_ = {
      shell, tp, time, pos, playBtn, recBtn, ruler, lanes, playhead, tl, headsScroll,
      editor, keys, chain, tabs, gutter, kbToggle, chToggle, status, snapSel,
      zoomRead, followBtn, selectionRead, duplicateBtn, deleteBtn, audioRead,
    };

    attachRulerInteractions(ruler);
    attachLaneInteractions(lanes);
    attachTimelineDrop(tl);
    attachBottomResize(gutter);
    buildKeyboardPanel();
    applyPanels();
    // The studio <main> is hidden at boot, so clientHeight is 0 until the view
    // is shown — re-clamp the panel height whenever the shell gains real size.
    new ResizeObserver(() => applyPanels()).observe(shell);
    syncStatus();
  }

  const editorOpen = () => bottom.active === "editor" && !!editRegion;

  function loadBottomState() {
    try {
      const s = JSON.parse(localStorage.getItem(PANELS_KEY));
      if (!s || typeof s !== "object") return;
      if (["keys", "chain"].includes(s.prev)) bottom.prev = s.prev;
      // Never restore "editor" across loads — its region no longer exists.
      if ([null, "keys", "chain"].includes(s.active)) bottom.active = s.active;
      else if (s.active === "editor") bottom.active = bottom.prev;
      bottom.h = Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, +s.h || BOTTOM_DEF));
    } catch {}
  }
  function saveBottomState() {
    try {
      localStorage.setItem(PANELS_KEY, JSON.stringify({ active: bottom.active, h: bottom.h, prev: bottom.prev }));
    } catch {}
  }

  function toggleBottomPanel(id) {
    if (id === "editor" && !editRegion) {
      _toast("Double-click a synth or drum region to edit it");
      return;
    }
    if (bottom.active === id) {
      bottom.reopen = id;
      bottom.active = null;
    } else {
      bottom.active = id;
      if (id !== "editor") bottom.prev = id;
    }
    applyPanels(); saveBottomState();
  }

  /** Close the piano roll and give the space back to the previous panel. */
  function closeEditor() {
    editRegion = null;
    if (bottom.active === "editor") bottom.active = bottom.prev;
    if (el_.editor) applyPanels();
    saveBottomState();
  }

  function applyPanels() {
    if (bottom.active === "editor" && !editRegion) bottom.active = bottom.prev;
    const editorWasHidden = el_.editor.hidden;
    el_.editor.hidden = bottom.active !== "editor";
    el_.keys.hidden = bottom.active !== "keys";
    el_.chain.hidden = bottom.active !== "chain";
    // Display-clamp only — the user's preferred height survives window shrinks.
    // shellH 0 means the studio view is hidden (no real measurement to clamp
    // against); any real height clamps, even short landscape-phone shells.
    const shellH = el_.shell.clientHeight;
    const maxH = shellH > 0 ? Math.max(56, shellH - 300) : BOTTOM_MAX;
    el_.shell.style.setProperty("--daw-bh", Math.min(bottom.h, maxH) + "px");
    el_.shell.classList.toggle("bottom-collapsed", !bottom.active);
    el_.tabs.querySelectorAll(".daw-tab").forEach((b) => {
      const active = b.dataset.panel === bottom.active;
      b.classList.toggle("active", active);
      b.setAttribute("aria-selected", active ? "true" : "false");
      if (b.dataset.panel === "editor") {
        b.classList.toggle("is-disabled", !editRegion);
        b.setAttribute("aria-disabled", editRegion ? "false" : "true");
      }
    });
    el_.kbToggle?.setAttribute("aria-pressed", bottom.active === "keys" ? "true" : "false");
    el_.chToggle?.setAttribute("aria-pressed", bottom.active === "chain" ? "true" : "false");
    // The editor DOM is only valid while visible: model edits made while it was
    // hidden (quantize, snap change) skip its re-render, so a reopen — via tab,
    // gutter drag or dblclick — must rebuild it, whatever path un-hid it.
    if (editorWasHidden && !el_.editor.hidden && editRegion) renderEditor();
  }

  function attachBottomResize(gutter) {
    let drag = null;
    gutter.addEventListener("pointerdown", (e) => {
      drag = { y: e.clientY, h: bottom.active ? bottom.h : 0 };
      try { gutter.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    gutter.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const raw = drag.h + (drag.y - e.clientY);       // dragging up grows the panel
      if (raw < BOTTOM_MIN * 0.55) {
        if (bottom.active) { bottom.reopen = bottom.active; bottom.active = null; }
      } else {
        if (!bottom.active) {
          const back = bottom.reopen && (bottom.reopen !== "editor" || editRegion) ? bottom.reopen : bottom.prev;
          bottom.active = back || "keys";
        }
        bottom.h = Math.max(BOTTOM_MIN, Math.min(BOTTOM_MAX, raw));
      }
      applyPanels();
    });
    const up = () => { if (drag) { drag = null; saveBottomState(); } };
    gutter.addEventListener("pointerup", up);
    gutter.addEventListener("pointercancel", up);
    gutter.addEventListener("dblclick", () => {
      bottom.h = BOTTOM_DEF;
      if (!bottom.active) bottom.active = bottom.prev || "keys";
      applyPanels(); saveBottomState();
    });
    gutter.addEventListener("keydown", (e) => {
      const step = e.shiftKey ? 40 : 12;
      if (e.key === "ArrowUp") bottom.h = Math.min(BOTTOM_MAX, bottom.h + step);
      else if (e.key === "ArrowDown") bottom.h = Math.max(BOTTOM_MIN, bottom.h - step);
      else if (e.key === "Enter" || e.key === " ") {
        toggleBottomPanel(bottom.active || bottom.prev || "keys");
        e.preventDefault();
        return;
      } else return;
      e.preventDefault(); applyPanels(); saveBottomState();
    });
  }

  function setZoom(v) {
    const tl = el_.tl;
    const centreBeat = tl ? (tl.scrollLeft + tl.clientWidth / 2) / pxPerBeat : 0;
    pxPerBeat = Math.max(6, Math.min(80, v));
    if (song?.view) song.view.zoom = pxPerBeat;
    renderTimeline();
    if (tl) tl.scrollLeft = Math.max(0, centreBeat * pxPerBeat - tl.clientWidth / 2);
    syncStatus();
    save();
  }

  function syncStatus() {
    if (!el_.status) return;
    el_.zoomRead.textContent = `ZOOM ${Math.round((pxPerBeat / 26) * 100)}%`;
    el_.snapSel.value = String(snapStep);
    el_.followBtn.classList.toggle("active", followPlayhead);
    el_.followBtn.setAttribute("aria-pressed", followPlayhead ? "true" : "false");
    const track = selRegion ? trackById(selRegion.trackId) : null;
    const region = track && regionById(track, selRegion.regionId);
    el_.selectionRead.textContent = region ? `${track.name} · ${region.name} · ${region.len.toFixed(2)} beats` : "No region selected";
    el_.duplicateBtn.disabled = !region;
    el_.deleteBtn.disabled = !region;
    try {
      const ctx = _getCtx();
      el_.audioRead.textContent = `${(ctx.sampleRate / 1000).toFixed(1)} kHz · ${ctx.state === "running" ? "Audio ready" : "Audio suspended"}`;
    } catch {
      el_.audioRead.textContent = "Audio ready";
    }
  }

  /* ---------------- rendering ---------------- */
  function renderAll() {
    applyPanels();
    syncTransport();
    renderHeads();
    renderTimeline();
    renderChain();
    if (editorOpen()) renderEditor();
    syncStatus();
  }

  /** The transport bar is built once — resync its widgets after undo/import. */
  function syncTransport() {
    const bpmIn = root.querySelector("#daw-bpm-in");
    if (bpmIn) bpmIn.value = song.bpm;
    const sig = root.querySelector("#daw-sig");
    if (sig) sig.value = `${song.ts.num}/${song.ts.den}`;
    const loopBtn = root.querySelector("#daw-loop");
    if (loopBtn) {
      loopBtn.classList.toggle("active", !!song.loop?.on);
      loopBtn.setAttribute("aria-pressed", song.loop?.on ? "true" : "false");
    }
  }

  function renderHeads() {
    const wrap = el_.headsScroll ?? $("#daw-heads-scroll");
    wrap.innerHTML = "";
    for (const t of song.tracks) {
      const h = el("div", "daw-head" + (t.id === activeTrackId ? " active" : ""));
      h.dataset.track = t.id;
      h.style.setProperty("--tc", TRACK_COLORS[t.color % TRACK_COLORS.length]);
      const strip = el("div", "daw-head-color");
      const name = el("input", "daw-head-name");
      name.value = t.name;
      name.setAttribute("aria-label", "Track name");
      name.addEventListener("change", () => { pushState(); t.name = name.value.slice(0, 24) || t.name; renderAll(); save(); });
      name.addEventListener("pointerdown", () => setActiveTrack(t.id));
      const row = el("div", "daw-head-btns");
      const mk = (cls, txt, label, on, fn) => {
        const b = iconBtn("daw-hbtn " + cls, txt, label);
        b.classList.toggle("active", !!on);
        b.setAttribute("aria-pressed", on ? "true" : "false");
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
        return b;
      };
      row.append(
        mk("daw-mute", "M", `Mute ${t.name}`, t.mute, () => { pushState(); t.mute = !t.mute; engine.refreshTrackParams(); renderHeads(); save(); }),
        mk("daw-solo", "S", `Solo ${t.name}`, t.solo, () => { pushState(); t.solo = !t.solo; engine.refreshTrackParams(); renderHeads(); save(); }),
        mk("daw-arm", "⏺", `Arm ${t.name} for recording`, t.armed, () => armTrack(t)),
      );
      const kind = el("span", "daw-head-kind",
        t.kind === "audio" ? "AUDIO" : t.kind === "drums" ? (KIT_LABELS[t.kit] || "DRUMS") : (SOUND_LABELS[t.family]?.[t.sound] || t.family));
      row.appendChild(kind);
      const delBtn = iconBtn("daw-hbtn daw-head-x", "×", `Delete ${t.name}`);
      let armedDel = false, delT = null;
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!armedDel) {
          armedDel = true; delBtn.textContent = "?"; delBtn.classList.add("confirm");
          delT = setTimeout(() => { armedDel = false; delBtn.textContent = "×"; delBtn.classList.remove("confirm"); }, 2600);
          return;
        }
        clearTimeout(delT);
        pushState();
        song.tracks = song.tracks.filter((x) => x !== t);
        if (activeTrackId === t.id) activeTrackId = song.tracks[0]?.id ?? null;
        // The editor may hold one of this track's regions while another tab is
        // in front — leaving it set would keep a ghost EDITOR tab alive.
        if (editRegion && (t.regions || []).includes(editRegion)) closeEditor();
        engine.rebuildTrack(t.id);
        renderAll(); save();
        _toast("Track deleted — Ctrl+Z to undo.");
      });
      h.append(strip, name, row, delBtn);
      h.addEventListener("pointerdown", () => setActiveTrack(t.id));
      wrap.appendChild(h);
    }
  }

  function setActiveTrack(id) {
    if (activeTrackId === id) return;
    activeTrackId = id;
    renderHeads(); renderChain();
  }

  function renderTimeline() {
    const ruler = el_.ruler, lanes = el_.lanes;
    const end = songEnd() + 8 * beatsPerBar();
    const width = end * pxPerBeat;
    ruler.innerHTML = ""; lanes.innerHTML = "";
    ruler.style.width = width + "px";
    lanes.style.width = width + "px";

    const bpb = beatsPerBar();
    for (let b = 0; b <= end; b += bpb) {
      const barN = Math.round(b / bpb) + 1;
      const tick = el("div", "daw-ruler-bar", String(barN));
      tick.style.left = b * pxPerBeat + "px";
      ruler.appendChild(tick);
    }
    if (song.loop.on) {
      const brace = el("div", "daw-loop-brace");
      brace.style.left = song.loop.a * pxPerBeat + "px";
      brace.style.width = Math.max(2, (song.loop.b - song.loop.a) * pxPerBeat) + "px";
      ruler.appendChild(brace);
    }

    for (const t of song.tracks) {
      const lane = el("div", "daw-lane");
      lane.dataset.track = t.id;
      lane.style.setProperty("--tc", TRACK_COLORS[t.color % TRACK_COLORS.length]);
      // bar grid backdrop
      lane.style.backgroundSize = `${bpb * pxPerBeat}px 100%, ${pxPerBeat}px 100%`;
      for (const r of t.regions) lane.appendChild(regionEl(t, r));
      lanes.appendChild(lane);
    }
    positionPlayhead(engine ? engine.beatNow() : 0);
    syncStatus();
  }

  function regionEl(t, r) {
    const d = el("div", "daw-region" + (selRegion && selRegion.regionId === r.id ? " sel" : ""));
    d.dataset.region = r.id;
    d.tabIndex = 0;
    d.setAttribute("role", "group");
    d.setAttribute("aria-label", `${r.name || "Region"} on ${t.name}, ${r.len.toFixed(2)} beats`);
    d.setAttribute("aria-selected", selRegion?.regionId === r.id ? "true" : "false");
    d.style.left = r.start * pxPerBeat + "px";
    d.style.width = Math.max(6, r.len * pxPerBeat) + "px";
    const label = el("span", "daw-region-name", r.name || "New Region");
    const cv = el("canvas", "daw-region-cv");
    d.append(label, cv, el("div", "daw-region-edge left"), el("div", "daw-region-edge right"));
    requestAnimationFrame(() => drawRegionPreview(cv, t, r));
    return d;
  }

  function drawRegionPreview(cv, t, r) {
    const w = Math.max(2, Math.round(r.len * pxPerBeat)), h = PREVIEW_H;
    cv.width = w * (devicePixelRatio || 1); cv.height = h * (devicePixelRatio || 1);
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(devicePixelRatio || 1, devicePixelRatio || 1);
    g.clearRect(0, 0, w, h);
    const ink = getComputedStyle(cv.closest(".daw-lane")).getPropertyValue("--tc") || "#8fd";
    g.fillStyle = ink; g.strokeStyle = ink; g.globalAlpha = 0.9;
    const px = (b) => (b / r.len) * w;
    if (t.kind === "audio") {
      const clip = clips.get(r.clipId);
      if (!clip) { g.globalAlpha = 0.4; g.fillRect(0, h / 2 - 1, w, 2); return; }
      const data = clip.getChannelData(0);
      const start = Math.floor((r.offset || 0) * clip.sampleRate);
      const span = Math.min(data.length - start, Math.floor(r.len * (60 / song.bpm) * clip.sampleRate));
      const step = Math.max(1, Math.floor(span / w));
      g.beginPath();
      for (let x = 0; x < w; x++) {
        let peak = 0;
        const s0 = start + x * step;
        for (let i = 0; i < step && s0 + i < data.length; i += 4) peak = Math.max(peak, Math.abs(data[s0 + i]));
        const y = peak * (h / 2 - 2);
        g.moveTo(x, h / 2 - y); g.lineTo(x, h / 2 + y + 0.5);
      }
      g.stroke();
    } else if (t.kind === "drums") {
      for (const hit of r.hits || []) {
        const row = DRUM_KEYS.indexOf(hit.k);
        g.fillRect(px(hit.b), 2 + (row / DRUM_KEYS.length) * (h - 6), 2.5, 2.5);
      }
    } else {
      const ns = r.notes || [];
      if (!ns.length) return;
      let lo = 127, hi = 0;
      ns.forEach((n) => { lo = Math.min(lo, n.m); hi = Math.max(hi, n.m); });
      const span = Math.max(12, hi - lo + 1);
      for (const n of ns) {
        const y = h - 3 - ((n.m - lo) / span) * (h - 6);
        g.fillRect(px(n.b), y, Math.max(2, px(n.d) - 1), 2);
      }
    }
  }

  /* ---------------- ruler: seek + loop range ---------------- */
  function attachRulerInteractions(ruler) {
    let drag = null;
    const beatAt = (e) => {
      const rect = ruler.getBoundingClientRect();
      return Math.max(0, (e.clientX - rect.left) / pxPerBeat);
    };
    ruler.addEventListener("pointerdown", (e) => {
      if (engine.recording) {
        _toast("Stop recording before moving the playhead or loop.", { severity: "error" });
        e.preventDefault();
        return;
      }
      drag = { start: beatAt(e), moved: false };
      try { ruler.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    ruler.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const b = beatAt(e);
      if (!drag.moved && Math.abs(b - drag.start) * pxPerBeat < 5) return;
      if (!drag.moved) { drag.moved = true; pushState(); song.loop.on = true; }
      song.loop.a = snap(Math.min(drag.start, b));
      song.loop.b = Math.max(song.loop.a + snapStep, snap(Math.max(drag.start, b)));
      renderTimeline();
      const loopButton = $("#daw-loop");
      loopButton?.classList.add("active");
      loopButton?.setAttribute("aria-pressed", "true");
    });
    const up = (e) => {
      if (!drag) return;
      const d = drag; drag = null;
      if (!d.moved) { engine.seek(snap(d.start)); updateClock(); }
      else { resyncPlayback(); save(); }
    };
    ruler.addEventListener("pointerup", up);
    ruler.addEventListener("pointercancel", () => { drag = null; });
  }

  /* ---------------- lane interactions (tools) ---------------- */
  function attachLaneInteractions(lanes) {
    let drag = null;
    const hitAt = (e) => {
      const lane = e.target.closest(".daw-lane");
      if (!lane) return null;
      const track = trackById(+lane.dataset.track);
      const rect = lane.getBoundingClientRect();
      const beat = Math.max(0, (e.clientX - rect.left) / pxPerBeat);
      const regionEl_ = e.target.closest(".daw-region");
      const region = regionEl_ ? regionById(track, +regionEl_.dataset.region) : null;
      const edge = e.target.classList.contains("daw-region-edge") ? (e.target.classList.contains("left") ? "left" : "right") : null;
      return { lane, track, beat, region, regionEl: regionEl_, edge };
    };

    lanes.addEventListener("pointerdown", (e) => {
      const h = hitAt(e);
      if (!h) return;
      setActiveTrack(h.track.id);
      e.preventDefault();
      try { lanes.setPointerCapture(e.pointerId); } catch {}

      if (tool === "split") {
        if (h.region) splitRegion(h.track, h.region, snap(h.beat));
        return;
      }
      // NEVER rebuild the timeline mid-gesture: the pointer's target node
      // would be replaced under it, and if capture failed the rest of the
      // gesture dies with the detached element. Mutate in place instead.
      const markSel = (regionEl_) => {
        lanes.querySelectorAll(".daw-region").forEach((x) => {
          const selected = x === regionEl_;
          x.classList.toggle("sel", selected);
          x.setAttribute("aria-selected", selected ? "true" : "false");
        });
        syncStatus();
      };
      if (tool === "draw") {
        if (h.track.kind === "audio") { _toast("Draw works on synth and drum tracks — record or import audio instead"); return; }
        pushState();
        const start = snap(h.beat);
        const r = makeRegion(h.track, start, snapStep);
        drag = { mode: "draw", track: h.track, region: r, anchor: start };
        selRegion = { trackId: h.track.id, regionId: r.id };
        const rEl = regionEl(h.track, r);
        h.lane.appendChild(rEl);
        markSel(rEl);
        return;
      }
      // select tool — the undo snapshot is deferred to the first REAL move or
      // resize: a plain selection click must not wipe the redo stack.
      if (h.region) {
        selRegion = { trackId: h.track.id, regionId: h.region.id };
        markSel(h.regionEl);
        drag = h.edge
          ? {
              mode: "resize",
              track: h.track,
              region: h.region,
              edge: h.edge,
              orig: {
                start: h.region.start,
                len: h.region.len,
                offset: h.region.offset || 0,
                region: structuredClone(h.region),
              },
              moved: false,
            }
          : { mode: "move", track: h.track, region: h.region, grab: h.beat - h.region.start, orig: h.region.start, moved: false };
      } else {
        selRegion = null;
        markSel(null);
      }
    });

    lanes.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const lanesRect = lanes.getBoundingClientRect();
      const beat = Math.max(0, (e.clientX - lanesRect.left) / pxPerBeat);
      const r = drag.region;
      if (drag.mode === "draw") {
        r.len = Math.max(snapStep, snap(beat) - r.start);
        if (snap(beat) < drag.anchor) { r.start = snap(beat); r.len = drag.anchor - r.start; }
        redrawRegion(drag.track, r);
      } else if (drag.mode === "move") {
        const ns = Math.max(0, snap(beat - drag.grab));
        if (ns !== r.start) {
          if (!drag.moved) pushState();     // capture the pre-move state once
          drag.moved = true;
          r.start = ns; redrawRegion(drag.track, r);
        }
      } else if (drag.mode === "resize") {
        if (!drag.moved) pushState();       // capture the pre-resize state once
        drag.moved = true;
        if (drag.edge === "right") {
          r.len = Math.max(snapStep, snap(beat) - r.start);
        } else {
          const ns = Math.min(snap(beat), drag.orig.start + drag.orig.len - snapStep);
          const delta = ns - drag.orig.start;
          r.start = Math.max(0, ns);
          r.len = drag.orig.len - delta;
          Object.assign(r, trimRegionStartContent(
            drag.track.kind,
            drag.orig.region,
            delta,
            60 / song.bpm,
          ));
        }
        redrawRegion(drag.track, r);
      }
    });

    const finish = () => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.mode === "draw" && d.region.len <= snapStep + 1e-6) {
        // A click (not a drag) draws one bar.
        d.region.len = beatsPerBar();
      }
      renderTimeline(); save();
      if (d.mode === "draw" && d.track.kind !== "audio") openEditor(d.track, d.region);
    };
    lanes.addEventListener("pointerup", finish);
    lanes.addEventListener("pointercancel", finish);

    lanes.addEventListener("dblclick", (e) => {
      const h = hitAt(e);
      if (h?.region && h.track.kind !== "audio") openEditor(h.track, h.region);
    });
  }

  function attachTimelineDrop(timeline) {
    const audioFile = (event) => [...(event.dataTransfer?.files || [])]
      .find((file) => file.type.startsWith("audio/") || /\.(wav|mp3|m4a|aac|ogg|flac)$/i.test(file.name));
    timeline.addEventListener("dragover", (event) => {
      if (!audioFile(event)) return;
      event.preventDefault();
      timeline.classList.add("drop-active");
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    });
    timeline.addEventListener("dragleave", (event) => {
      if (!timeline.contains(event.relatedTarget)) timeline.classList.remove("drop-active");
    });
    timeline.addEventListener("drop", async (event) => {
      const file = audioFile(event);
      timeline.classList.remove("drop-active");
      if (!file) return;
      event.preventDefault();
      const rect = timeline.getBoundingClientRect();
      const beat = snap((event.clientX - rect.left + timeline.scrollLeft) / pxPerBeat);
      const laneY = event.clientY - rect.top + timeline.scrollTop - (el_.ruler?.offsetHeight || 0);
      const laneIndex = Math.max(0, Math.min(song.tracks.length - 1, Math.floor(laneY / LANE_H)));
      let track = song.tracks[laneIndex];
      if (!track || track.kind !== "audio") {
        pushState();
        track = makeTrack("audio", { name: file.name.replace(/\.[^.]+$/, "") || "Audio" });
        song.tracks.splice(Math.min(song.tracks.length, laneIndex + 1), 0, track);
        activeTrackId = track.id;
        engine.rebuildTrack(track.id);
        renderHeads();
      }
      await importAudioBlob(track, file, beat);
    });
  }

  function redrawRegion(track, r) {
    const dEl = el_.lanes.querySelector(`.daw-region[data-region="${r.id}"]`);
    if (!dEl) return;
    dEl.style.left = r.start * pxPerBeat + "px";
    dEl.style.width = Math.max(6, r.len * pxPerBeat) + "px";
    const cv = dEl.querySelector("canvas");
    if (cv) drawRegionPreview(cv, track, r);
  }

  function splitRegion(track, r, atBeat) {
    if (atBeat <= r.start + snapStep / 2 || atBeat >= r.start + r.len - snapStep / 2) return;
    pushState();
    const cut = atBeat - r.start;
    const content = splitRegionContent(track.kind, r, cut, 60 / song.bpm);
    const right = makeRegion(track, atBeat, content.right.len, { name: r.name });
    Object.assign(r, content.left);
    Object.assign(right, content.right);
    selRegion = { trackId: track.id, regionId: right.id };
    renderTimeline(); save();
  }

  function duplicateSelected() {
    if (!selRegion) return;
    const track = trackById(selRegion.trackId);
    const region = regionById(track, selRegion.regionId);
    if (!track || !region) return;
    pushState();
    const copy = duplicateRegion(region, idc++, snap(region.start + region.len));
    track.regions.push(copy);
    selRegion = { trackId: track.id, regionId: copy.id };
    renderTimeline();
    save();
    _toast("Region duplicated", { severity: "ok" });
  }

  function nudgeSelected(delta) {
    if (!selRegion) return;
    const track = trackById(selRegion.trackId);
    const region = regionById(track, selRegion.regionId);
    if (!track || !region) return;
    // Alt+Arrow auto-repeats — a held key is one gesture, not one per repeat.
    pushStateGesture("nudge:" + region.id);
    region.start = Math.max(0, snap(region.start + delta));
    renderTimeline();
    save();
  }

  function deleteSelected() {
    if (!selRegion) return;
    const t = trackById(selRegion.trackId);
    const r = regionById(t, selRegion.regionId);
    if (!t || !r) return;
    pushState();
    t.regions = t.regions.filter((x) => x !== r);
    if (editRegion === r) closeEditor();
    selRegion = null;
    renderTimeline(); save();
    _toast("Region deleted — Ctrl+Z to undo.");
  }

  function quantizeSelected() {
    if (!selRegion) { _toast("Select a region to quantize"); return; }
    const t = trackById(selRegion.trackId);
    const r = regionById(t, selRegion.regionId);
    if (!t || !r) return;
    pushState();
    const updates = quantizeRegionNotes(t.kind, r, snapStep);
    Object.assign(r, updates);
    renderTimeline();
    if (editorOpen() && editRegion === r) renderEditor();
    save();
    _toast(`Quantized notes to ${snapStep} beat grid`, { severity: "ok" });
  }

  function transposeSelected(semitones) {
    const r = editRegion || (selRegion && regionById(trackById(selRegion.trackId), selRegion.regionId));
    if (!r || !Array.isArray(r.notes)) return;
    pushState();
    Object.assign(r, transposeRegionNotes(r, semitones));
    renderTimeline();
    if (editorOpen() && editRegion === r) renderEditor();
    save();
    _toast(`Transposed ${semitones > 0 ? "+" + semitones : semitones} semitones`);
  }

  function nudgeRegionNotes(deltaBeats) {
    const r = editRegion || (selRegion && regionById(trackById(selRegion.trackId), selRegion.regionId));
    if (!r) return;
    pushState();
    if (Array.isArray(r.notes)) {
      r.notes.forEach((n) => { n.b = Math.max(0, snap(n.b + deltaBeats)); });
    }
    if (Array.isArray(r.hits)) {
      r.hits.forEach((h) => { h.b = Math.max(0, snap(h.b + deltaBeats)); });
    }
    renderTimeline();
    if (editorOpen() && editRegion === r) renderEditor();
    save();
    _toast(`Shifted notes by ${deltaBeats > 0 ? "+" + deltaBeats : deltaBeats} beats`);
  }

  async function exportStemsWav() {
    const end = songEnd();
    if (end <= 0) { _toast("Nothing to render yet"); return; }
    _toast("Rendering stems…");
    try {
      const stems = await engine.renderOfflineStems(0, end);
      if (!stems || !stems.size) { _toast("Could not render stems", { severity: "error" }); return; }
      let count = 0;
      for (const [trackId, buf] of stems) {
        const tr = trackById(trackId);
        if (!tr) continue;
        // Fired in one burst, browsers block all but the first download.
        if (count) await new Promise((r) => setTimeout(r, 400));
        const wavBlob = bufferToWav(buf);
        const url = URL.createObjectURL(wavBlob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `stem-${tr.name.replace(/[^a-z0-9]/gi, "_")}.wav`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        count++;
      }
      _toast(`Exported ${count} stem WAV files`, { severity: "ok" });
    } catch (e) {
      console.warn(e);
      _toast("Could not render stems", { severity: "error" });
    }
  }

  function exportMidiFile() {
    const end = songEnd();
    if (end <= 0) { _toast("Nothing to export yet"); return; }
    const ticksPerQuarter = 480;
    const tracksData = [];
    for (const t of song.tracks) {
      if (t.kind === "audio") continue;
      const notesData = [];
      for (const r of t.regions || []) {
        if (t.kind === "drums") {
          for (const h of r.hits || []) {
            const rowIx = DRUM_KEYS.indexOf(h.k);
            const midiNote = 36 + (rowIx >= 0 ? rowIx : 0);
            notesData.push({
              tick: Math.round((r.start + h.b) * ticksPerQuarter),
              dur: Math.round(0.25 * ticksPerQuarter),
              note: midiNote,
              vel: Math.round((h.v ?? 1) * 127),
            });
          }
        } else {
          for (const n of r.notes || []) {
            notesData.push({
              tick: Math.round((r.start + n.b) * ticksPerQuarter),
              dur: Math.round((n.d || 0.25) * ticksPerQuarter),
              note: n.m,
              vel: Math.round((n.v ?? 1) * 127),
            });
          }
        }
      }
      if (notesData.length) {
        tracksData.push({
          name: t.name,
          channel: t.kind === "drums" ? 9 : 0,
          notes: notesData,
        });
      }
    }
    if (!tracksData.length) { _toast("No MIDI notes to export"); return; }
    const midiBytes = encodeMidi({
      ticksPerQuarter,
      tempoBpm: song.bpm,
      timeSigs: [{ tick: 0, num: song.ts.num, den: song.ts.den }],
      tracks: tracksData,
    });
    const blob = new Blob([midiBytes], { type: "audio/midi" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = `sxratch-${song.bpm}bpm.mid`; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    _toast("Exported MIDI file", { severity: "ok" });
  }

  async function bounceToSamplerPad() {
    const sampler = _getSampler?.();
    if (!sampler) { _toast("Sampler unavailable"); return; }
    const tr = activeTrack();
    if (!tr) return;
    _toast(`Bouncing ${tr.name} track…`);
    try {
      const end = songEnd();
      const buf = await engine.renderOffline(0, end, { onlyTrackId: tr.id });
      if (!buf) { _toast("Could not render track audio", { severity: "error" }); return; }
      const padId = (tr.id % 8) + 1;
      sampler.setPadSample(padId, buf, tr.name);
      _toast(`Loaded ${tr.name} onto Sampler Pad ${padId}`, { severity: "ok" });
    } catch (e) {
      console.warn(e);
      _toast("Could not bounce track to sampler", { severity: "error" });
    }
  }

  /* ---------------- transport UI ---------------- */
  async function togglePlay() {
    if (engine.recording) { await finishRecording(); return; }
    if (engine.playing) engine.stop();
    else engine.play(engine.beatNow());
    updateTransportButtons();
  }

  function updateTransportButtons() {
    el_.playBtn.textContent = engine.playing ? "■" : "▶";
    el_.playBtn.classList.toggle("playing", engine.playing);
    el_.recBtn.classList.toggle("recording", engine.recording);
  }

  function positionPlayhead(beat) {
    el_.playhead.style.transform = `translateX(${beat * pxPerBeat}px)`;
    // Absolute children of a scroll container size against its viewport, not
    // its content — stretch to cover ruler + every lane explicitly.
    const h = (el_.ruler?.offsetHeight || 0) + (el_.lanes?.offsetHeight || 0);
    if (h && el_.playhead.offsetHeight !== h) el_.playhead.style.height = h + "px";
  }

  function updateClock() {
    const b = engine.beatNow();
    const sec = b * (60 / song.bpm);
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60), cs = Math.floor((sec % 1) * 100);
    el_.time.textContent = `${m}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
    const bpb = beatsPerBar();
    el_.pos.textContent = formatMusicalPosition(b, bpb, snapStep);
    positionPlayhead(b);
  }

  let liveRecEl = null;

  function updateLiveRecordingRegion() {
    const rec = engine.rec;
    if (!rec || rec.kind !== "audio" || !rec.cap) {
      removeLiveRecordingRegion();
      return;
    }
    const t = trackById(rec.trackId);
    if (!t) return;
    const lane = el_.lanes.querySelector(`.daw-lane[data-track="${t.id}"]`);
    if (!lane) return;

    if (!liveRecEl || liveRecEl.parentNode !== lane) {
      removeLiveRecordingRegion();
      liveRecEl = el("div", "daw-region daw-region-recording");
      liveRecEl.style.setProperty("--tc", TRACK_COLORS[t.color % TRACK_COLORS.length]);
      const label = el("span", "daw-region-name", "RECORDING…");
      const cv = el("canvas", "daw-region-cv");
      liveRecEl.append(label, cv);
      lane.appendChild(liveRecEl);
    }

    const currentBeat = engine.beatNow();
    const lenBeats = Math.max(0.1, currentBeat - rec.startBeat);
    liveRecEl.style.left = (rec.startBeat * pxPerBeat) + "px";
    liveRecEl.style.width = Math.max(6, lenBeats * pxPerBeat) + "px";

    const cv = liveRecEl.querySelector(".daw-region-cv");
    if (cv) drawLiveWaveform(cv, rec.cap.chunks, lenBeats);
  }

  function removeLiveRecordingRegion() {
    if (liveRecEl) {
      liveRecEl.remove();
      liveRecEl = null;
    }
  }

  function drawLiveWaveform(cv, chunks, lenBeats) {
    if (!cv || !chunks || !chunks.length) return;
    const w = Math.max(2, Math.round(lenBeats * pxPerBeat));
    const h = PREVIEW_H;
    const dpr = devicePixelRatio || 1;
    if (cv.width !== w * dpr || cv.height !== h * dpr) {
      cv.width = w * dpr;
      cv.height = h * dpr;
    }
    const g = cv.getContext("2d");
    if (!g) return;
    g.save();
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);

    const ink = getComputedStyle(cv.closest(".daw-lane") || cv.parentElement)?.getPropertyValue("--tc") || "#ff4081";
    g.fillStyle = ink;
    g.strokeStyle = ink;
    g.globalAlpha = 0.95;

    const totalSamples = chunks.reduce((acc, c) => acc + (c[0]?.length || 0), 0);
    if (totalSamples === 0) { g.restore(); return; }

    const samplesPerPixel = Math.max(1, Math.floor(totalSamples / w));
    g.beginPath();

    let chunkIdx = 0;
    let sampleIdx = 0;

    for (let x = 0; x < w; x++) {
      let peak = 0;
      let count = 0;
      while (count < samplesPerPixel && chunkIdx < chunks.length) {
        const blk = chunks[chunkIdx][0];
        if (!blk) { chunkIdx++; sampleIdx = 0; continue; }
        const s = Math.abs(blk[sampleIdx] || 0);
        if (s > peak) peak = s;
        sampleIdx += 4;
        count += 4;
        if (sampleIdx >= blk.length) {
          chunkIdx++;
          sampleIdx = 0;
        }
      }
      const y = peak * (h / 2 - 2);
      g.moveTo(x, h / 2 - y);
      g.lineTo(x, h / 2 + y + 0.5);
    }
    g.stroke();
    g.restore();
  }

  function rafLoop() {
    updateClock();
    if (engine.playing && followPlayhead) {
      // keep the playhead in view
      const x = engine.beatNow() * pxPerBeat;
      const tl = el_.tl;
      if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - 80) tl.scrollLeft = Math.max(0, x - 80);
    }
    if (engine.recording && engine.rec && engine.rec.kind === "audio") {
      updateLiveRecordingRegion();
    } else {
      removeLiveRecordingRegion();
    }
    const m = root?.querySelector("#daw-meter i");
    if (m) m.style.width = (engine.playing || engine.recording ? engine.masterLevel() * 100 : 0) + "%";
    rafId = requestAnimationFrame(rafLoop);
  }

  /* ---------------- recording ---------------- */
  async function armTrack(t) {
    const on = !t.armed;
    song.tracks.forEach((x) => { x.armed = false; });
    t.armed = on;
    renderHeads(); renderChain(); save();
    if (on && t.kind === "audio") {
      // Surface the device list up front so the pick is ready before ⏺.
      try {
        await navigator.mediaDevices.getUserMedia({ audio: true }).then((s) => s.getTracks().forEach((x) => x.stop()));
        inputDevices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
        renderChain();
      } catch {
        _toast("Microphone access was blocked — recording needs an input.", { severity: "error" });
      }
    }
    if (on) _toast(`${t.name} armed — press ● to record`);
  }

  async function toggleRecord() {
    if (engine.recording) { await finishRecording(); return; }
    const t = song.tracks.find((x) => x.armed);
    if (!t) { _toast("Arm a track first (⏺ on its header)"); return; }
    const pending = engine.record(t, { deviceId: t.inputId });
    updateTransportButtons();              // light ● immediately, incl. count-in
    const ok = await pending;
    updateTransportButtons();
    if (ok) _toast(`Recording ${t.name}…`, { severity: "ok" });
  }

  async function finishRecording() {
    const wasCountIn = engine.pendingRecord;
    const take = await engine.stopRecord();
    removeLiveRecordingRegion();
    updateTransportButtons();
    if (!take) { _toast(wasCountIn ? "Count-in cancelled" : "Nothing was recorded"); return; }
    const t = trackById(take.trackId);
    if (!t) return;
    pushState();
    let stored = true;
    if (take.kind === "audio") {
      const clipId = CLIP_PREFIX + Date.now();
      clips.set(clipId, take.buffer);
      try {
        stored = await saveSample(clipId, "Recording", take.buffer, { pinned: true });
      } catch {
        stored = false;
      }
      const startBeat = snap(take.startBeat);
      const startDeltaSec = (take.startBeat - startBeat) * (60 / song.bpm);
      const latencySec = Math.max(0, (take.latencySec || 0) + startDeltaSec);
      const validDurationSec = Math.max(0.1, take.buffer.duration - latencySec);
      const lenBeats = Math.max(snapStep, snap(validDurationSec * (song.bpm / 60)));

      const r = makeRegion(t, startBeat, lenBeats, {
        name: `Take ${t.regions.length + 1}`,
        clipId,
        offset: latencySec,
      });
      if (!stored) r.volatile = true;
      selRegion = { trackId: t.id, regionId: r.id };
    } else {
      const loopLen = take.loop ? take.loop.b - take.loop.a : null;
      let len = loopLen || Math.max(beatsPerBar(), snap(take.lenBeats, "ceil"));
      const takeBeat = (b) => {
        const q = snap(b);
        return loopLen && q >= loopLen - 1e-7 ? 0 : Math.max(0, q);
      };
      const notes = (take.notes || []).map((n) => ({ ...n, b: takeBeat(n.b) }));
      const hits = (take.hits || []).map((h) => ({ ...h, b: takeBeat(h.b) }));
      if (!loopLen) {
        const contentEnd = Math.max(
          0,
          ...notes.map((n) => n.b + Math.max(MIN_SNAP, n.d || MIN_SNAP)),
          ...hits.map((h) => h.b + snapStep),
        );
        len = Math.max(len, snap(contentEnd, "ceil"));
      }
      notes.forEach((n) => {
        n.d = Math.max(MIN_SNAP, Math.min(n.d || MIN_SNAP, len - n.b));
      });
      const r = makeRegion(t, snap(take.loop?.a ?? take.startBeat), len, {
        name: `Take ${t.regions.length + 1}`,
        notes,
        hits,
      });
      selRegion = { trackId: t.id, regionId: r.id };
    }
    renderTimeline(); save();
    if (stored) {
      _toast("Take captured", { severity: "ok" });
    } else {
      _toast(
        "Take captured for this session, but browser storage could not save its audio. Export before closing this tab.",
        { severity: "error", duration: 8000 },
      );
    }
  }

  /* ---------------- virtual keyboard ---------------- */
  function buildKeyboardPanel() {
    const k = el_.keys;
    k.innerHTML = "";
    const head = el("div", "daw-panel-head");
    head.append(el("span", "daw-panel-title", "VIRTUAL KEYBOARD"));
    const close = iconBtn("daw-hbtn", "×", "Hide keyboard");
    close.addEventListener("click", () => toggleBottomPanel("keys"));
    head.appendChild(close);

    const octWrap = el("div", "daw-oct");
    const octDown = iconBtn("daw-hbtn", "−", "Octave down");
    const octVal = el("span", "daw-oct-val", String(octave));
    const octUp = iconBtn("daw-hbtn", "＋", "Octave up");
    octDown.addEventListener("click", () => { octave = Math.max(0, octave - 1); octVal.textContent = octave; paintKbSel(); });
    octUp.addEventListener("click", () => { octave = Math.min(7, octave + 1); octVal.textContent = octave; paintKbSel(); });
    octWrap.append(el("span", "daw-panel-title", "OCTAVE"), octDown, octVal, octUp);

    const bed = el("div", "daw-kbd");
    const LO = 24, HI = 96;                        // C1..C7 on screen
    const whites = [];
    for (let m = LO; m <= HI; m++) if (![1, 3, 6, 8, 10].includes(m % 12)) whites.push(m);
    bed.style.setProperty("--wn", whites.length);
    whites.forEach((m, i) => {
      const w = el("button", "daw-key white");
      w.dataset.midi = m;
      w.style.left = `calc(${i} * var(--kw))`;
      w.setAttribute("aria-label", keyName(m));
      if (m % 12 === 0) w.appendChild(el("span", "daw-key-label", keyName(m)));
      bed.appendChild(w);
      if ([0, 2, 5, 7, 9].includes(m % 12) && m + 1 <= HI) {
        const b = el("button", "daw-key black");
        b.dataset.midi = m + 1;
        b.style.left = `calc(${i + 1} * var(--kw) - var(--bw) / 2)`;
        b.setAttribute("aria-label", keyName(m + 1));
        bed.appendChild(b);
      }
    });
    const activePointerNotes = new Map();
    bed.addEventListener("pointerdown", (e) => {
      const key = e.target.closest(".daw-key");
      if (!key) return;
      e.preventDefault();
      const t = activeTrack();
      if (!t) return;
      const midi = +key.dataset.midi;
      if (isNaN(midi)) return;
      activePointerNotes.set(e.pointerId, { trackId: t.id, midi, keyEl: key });
      engine.noteOn(t, midi, 1);
      key.classList.add("held");
      try { key.setPointerCapture(e.pointerId); } catch {}
    });

    const releaseKey = (e) => {
      const active = activePointerNotes.get(e.pointerId);
      if (!active) return;
      activePointerNotes.delete(e.pointerId);
      const track = trackById(active.trackId);
      if (track) engine.noteOff(track, active.midi);
      active.keyEl.classList.remove("held");
      try { active.keyEl.releasePointerCapture(e.pointerId); } catch {}
    };

    window.addEventListener("pointerup", releaseKey, true);
    window.addEventListener("pointercancel", releaseKey, true);
    bed.addEventListener("pointerleave", releaseKey);
    bed.addEventListener("lostpointercapture", releaseKey);

    const wrap = el("div", "daw-kbd-scroll");
    wrap.appendChild(bed);
    const kbody = el("div", "daw-keys-body");
    kbody.append(octWrap, wrap);
    k.append(head, kbody);
    requestAnimationFrame(() => {
      wrap.scrollLeft = Math.max(0, ((60 - LO) / (HI - LO)) * bed.scrollWidth - wrap.clientWidth / 2);
      paintKbSel();
    });
  }

  function paintKbSel() {
    const base = (octave + 1) * 12;
    el_.keys.querySelectorAll(".daw-key").forEach((k) => {
      const m = +k.dataset.midi;
      const semi = m - base;
      const label = SEMI_TO_LABEL[semi];
      k.classList.toggle("qwerty", semi >= 0 && semi <= 17);

      let badge = k.querySelector(".daw-qwerty-badge");
      if (semi >= 0 && semi <= 17 && label) {
        if (!badge) {
          badge = el("span", "daw-qwerty-badge");
          k.appendChild(badge);
        }
        badge.textContent = label;
      } else if (badge) {
        badge.remove();
      }
    });
  }

  function onKeyDown(e) {
    if (!document.body.classList.contains("view-studio")) return;
    if (e.target.closest && e.target.closest("input, textarea, select, [contenteditable]")) return;
    // Studio-global shortcuts.
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); e.stopPropagation(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.code === "KeyY" || (e.shiftKey && e.code === "KeyZ"))) { e.preventDefault(); e.stopPropagation(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyD") { e.preventDefault(); e.stopPropagation(); duplicateSelected(); return; }
    if (e.code === "KeyQ" && !(e.ctrlKey || e.metaKey || e.altKey)) { e.preventDefault(); e.stopPropagation(); quantizeSelected(); return; }
    if (e.code === "KeyZ" && !(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)) {
      e.preventDefault(); e.stopPropagation();
      octave = Math.max(0, octave - 1);
      const octVal = el_.keys?.querySelector(".daw-oct-val");
      if (octVal) octVal.textContent = octave;
      paintKbSel();
      _toast(`Octave ${octave}`, { severity: "ok" });
      return;
    }
    if (e.code === "KeyX" && !(e.ctrlKey || e.metaKey || e.altKey || e.shiftKey)) {
      e.preventDefault(); e.stopPropagation();
      octave = Math.min(7, octave + 1);
      const octVal = el_.keys?.querySelector(".daw-oct-val");
      if (octVal) octVal.textContent = octave;
      paintKbSel();
      _toast(`Octave ${octave}`, { severity: "ok" });
      return;
    }
    if (e.altKey && (e.code === "ArrowLeft" || e.code === "ArrowRight")) {
      e.preventDefault(); e.stopPropagation();
      const amount = e.shiftKey ? beatsPerBar() : snapStep;
      nudgeSelected(e.code === "ArrowLeft" ? -amount : amount);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Space") { e.preventDefault(); e.stopPropagation(); togglePlay(); return; }
    if (e.code === "Delete" || e.code === "Backspace") { e.stopPropagation(); deleteSelected(); return; }
    if (e.code === "Escape") {
      if (editorOpen()) { closeEditor(); return; }
      selRegion = null;
      renderTimeline();
      return;
    }
    if (e.code === "Enter" && selRegion) {
      const track = trackById(selRegion.trackId);
      const region = regionById(track, selRegion.regionId);
      if (track && region && track.kind !== "audio") openEditor(track, region);
      return;
    }
    if (e.repeat) { if (QWERTY[e.code] != null) e.stopPropagation(); return; }
    const semis = QWERTY[e.code];
    if (semis == null) return;
    e.preventDefault();
    e.stopPropagation();                       // keep the deck keymap out of the studio
    const t = activeTrack();
    if (!t) return;
    const midi = (octave + 1) * 12 + semis;
    heldKeys.set(e.code, { trackId: t.id, midi });
    engine.noteOn(t, midi, 1);
    const kEl = el_.keys.querySelector(`.daw-key[data-midi="${midi}"]`);
    kEl?.classList.add("held");
  }
  function onKeyUp(e) {
    const held = heldKeys.get(e.code);
    if (!held) return;
    heldKeys.delete(e.code);
    const track = trackById(held.trackId);
    if (track) engine.noteOff(track, held.midi);
    el_.keys.querySelector(`.daw-key[data-midi="${held.midi}"]`)?.classList.remove("held");
  }

  /* ---------------- piano-roll editor ---------------- */
  function openEditor(track, region) {
    editRegion = region;
    bottom.active = "editor";
    applyPanels();
    renderEditor();
    saveBottomState();
  }

  function renderEditor() {
    const p = el_.editor;
    const track = song.tracks.find((t) => (t.regions || []).includes(editRegion));
    if (!track || !editRegion) { closeEditor(); return; }
    const r = editRegion;
    p.innerHTML = "";
    const head = el("div", "daw-panel-head");
    const nameIn = el("input", "daw-region-rename");
    nameIn.value = r.name || "New Region";
    nameIn.setAttribute("aria-label", "Region name");
    nameIn.addEventListener("change", () => { pushState(); r.name = nameIn.value.slice(0, 32); renderTimeline(); save(); });
    head.append(el("span", "daw-panel-title", "EDIT — " + track.name), nameIn);

    const toolsWrap = el("div", "daw-roll-header-tools");
    if (track.kind === "midi") {
      const nLeft = iconBtn("daw-hbtn", "◀", "Shift notes left");
      nLeft.addEventListener("click", () => nudgeRegionNotes(-snapStep));
      const nRight = iconBtn("daw-hbtn", "▶", "Shift notes right");
      nRight.addEventListener("click", () => nudgeRegionNotes(snapStep));
      const tDown12 = iconBtn("daw-hbtn", "-12", "Transpose octave down");
      tDown12.addEventListener("click", () => transposeSelected(-12));
      const tDown1 = iconBtn("daw-hbtn", "-1", "Transpose semitone down");
      tDown1.addEventListener("click", () => transposeSelected(-1));
      const tUp1 = iconBtn("daw-hbtn", "+1", "Transpose semitone up");
      tUp1.addEventListener("click", () => transposeSelected(1));
      const tUp12 = iconBtn("daw-hbtn", "+12", "Transpose octave up");
      tUp12.addEventListener("click", () => transposeSelected(12));
      toolsWrap.append(nLeft, nRight, tDown12, tDown1, tUp1, tUp12);
    }
    const qBtn = iconBtn("daw-hbtn", "Q", "Quantize notes (Q)");
    qBtn.addEventListener("click", quantizeSelected);
    toolsWrap.appendChild(qBtn);

    const close = iconBtn("daw-hbtn", "×", "Close editor");
    close.addEventListener("click", closeEditor);
    head.append(toolsWrap, close);

    const grid = el("div", "daw-roll");
    const cols = Math.max(1, Math.round(r.len / snapStep));
    grid.style.setProperty("--cols", cols);
    const isDrums = track.kind === "drums";
    let rows;
    if (isDrums) rows = DRUM_KEYS.map((k) => ({ key: k, label: DRUM_LABELS[k] }));
    else {
      let lo = 55, hi = 67;
      (r.notes || []).forEach((n) => { lo = Math.min(lo, n.m); hi = Math.max(hi, n.m); });
      lo = Math.max(12, lo - 2); hi = Math.min(108, Math.max(hi + 2, lo + 13));
      rows = [];
      for (let m = hi; m >= lo; m--) rows.push({ midi: m, label: keyName(m) });
    }
    for (const row of rows) {
      const rowEl = el("div", "daw-roll-row" + (row.midi != null && [1, 3, 6, 8, 10].includes(row.midi % 12) ? " black" : ""));
      rowEl.appendChild(el("span", "daw-roll-label", row.label));
      for (let c = 0; c < cols; c++) {
        const cell = el("button", "daw-roll-cell" + (c % 4 === 0 ? " beat" : ""));
        const b = c * snapStep;
        let on = false, isStart = false;
        if (isDrums) {
          on = (r.hits || []).some((h) => Math.abs(h.b - b) < snapStep / 2 && h.k === row.key);
          isStart = on;
        } else {
          const n = (r.notes || []).find((n) => n.m === row.midi && (b >= n.b - snapStep / 2 && b < n.b + (n.d || snapStep) - 1e-4));
          on = !!n;
          isStart = (r.notes || []).some((n) => n.m === row.midi && Math.abs(n.b - b) < snapStep / 2);
        }
        if (on) cell.classList.add("on");
        if (isStart) cell.classList.add("start");
        cell.dataset.c = c;
        cell.setAttribute("aria-label", `${row.label} — beat ${Math.floor(b) + 1}.${Math.round((b % 1) * 4) + 1}${on ? " — on" : ""}`);
        cell.addEventListener("click", () => {
          pushState();
          if (isDrums) {
            const ix = (r.hits || []).findIndex((h) => Math.abs(h.b - b) < snapStep / 2 && h.k === row.key);
            if (ix >= 0) r.hits.splice(ix, 1);
            else { r.hits.push({ b, k: row.key, v: 1 }); engine.noteOn(track, DRUM_KEYS.indexOf(row.key), 1); }
          } else {
            const ix = (r.notes || []).findIndex((n) => n.m === row.midi && (Math.abs(n.b - b) < snapStep / 2 || (b >= n.b && b < n.b + (n.d || snapStep))));
            if (ix >= 0) r.notes.splice(ix, 1);
            else { r.notes.push({ b, d: snapStep * 2, m: row.midi, v: 1 }); engine.noteOn(track, row.midi, 1); }
          }
          renderEditor(); redrawRegion(track, r); save();
        });
        rowEl.appendChild(cell);
      }
      grid.appendChild(rowEl);
    }
    const scroll = el("div", "daw-roll-scroll");
    scroll.appendChild(grid);

    // Velocity Bar Editor
    const velLane = el("div", "daw-velocity-lane");
    velLane.style.setProperty("--cols", cols);
    const velLabel = el("span", "daw-roll-label", "VELOCITY");
    const velGrid = el("div", "daw-vel-grid");
    for (let c = 0; c < cols; c++) {
      const b = c * snapStep;
      const col = el("div", "daw-vel-col");
      col.dataset.c = c;
      let maxVel = 0;
      if (isDrums) {
        const hitsAt = (r.hits || []).filter((h) => Math.abs(h.b - b) < snapStep / 2);
        hitsAt.forEach((h) => { maxVel = Math.max(maxVel, h.v ?? 1); });
      } else {
        const notesAt = (r.notes || []).filter((n) => Math.abs(n.b - b) < 1e-6);
        notesAt.forEach((n) => { maxVel = Math.max(maxVel, n.v ?? 1); });
      }
      const bar = el("div", "daw-vel-bar");
      bar.style.height = maxVel > 0 ? `${maxVel * 100}%` : "0%";
      col.appendChild(bar);
      col.title = maxVel > 0 ? `Beat ${(b + 1).toFixed(2)} Velocity: ${Math.round(maxVel * 127)}` : "Set Velocity";

      let dragVel = false;
      const updateVel = (e) => {
        const rect = col.getBoundingClientRect();
        const v = Math.max(0.1, Math.min(1, 1 - (e.clientY - rect.top) / rect.height));
        if (isDrums) {
          (r.hits || []).filter((h) => Math.abs(h.b - b) < snapStep / 2).forEach((h) => { h.v = v; });
        } else {
          (r.notes || []).filter((n) => Math.abs(n.b - b) < 1e-6).forEach((n) => { n.v = v; });
        }
        bar.style.height = `${v * 100}%`;
        col.title = `Beat ${(b + 1).toFixed(2)} Velocity: ${Math.round(v * 127)}`;
        save();
      };
      // One undo entry per drag, captured before the first change.
      col.addEventListener("pointerdown", (e) => { pushState(); dragVel = true; updateVel(e); try { col.setPointerCapture(e.pointerId); } catch {} e.preventDefault(); });
      col.addEventListener("pointermove", (e) => { if (dragVel) updateVel(e); });
      col.addEventListener("pointerup", () => { dragVel = false; });
      col.addEventListener("pointercancel", () => { dragVel = false; });
      velGrid.appendChild(col);
    }
    velLane.append(velLabel, velGrid);

    p.append(head, scroll, velLane);
  }

  /* ---------------- device chain ---------------- */
  let _knobSeq = 0;
  function knob(label, get, set, { min = 0, max = 1, fmt = (v) => Math.round(v * 100) + "%" } = {}) {
    const gestureKey = "knob:" + _knobSeq++;
    const wrap = el("div", "daw-knob-wrap");
    const k = el("div", "daw-knob");
    k.tabIndex = 0;
    k.setAttribute("role", "slider");
    k.setAttribute("aria-label", label);
    k.setAttribute("aria-valuemin", String(min));
    k.setAttribute("aria-valuemax", String(max));
    const read = el("span", "daw-knob-read");
    const paint = () => {
      const v = get();
      const t = (v - min) / (max - min);
      k.style.setProperty("--rot", `${-135 + t * 270}deg`);
      k.setAttribute("aria-valuenow", String(Math.round(v * 100) / 100));
      k.setAttribute("aria-valuetext", fmt(v));
      read.textContent = fmt(v);
    };
    let startY = null, startV = null;
    k.addEventListener("pointerdown", (e) => { pushState(); startY = e.clientY; startV = get(); try { k.setPointerCapture(e.pointerId); } catch {} e.preventDefault(); });
    k.addEventListener("pointermove", (e) => {
      if (startY == null) return;
      const t = (startV - min) / (max - min) + (startY - e.clientY) / 150;
      set(min + Math.max(0, Math.min(1, t)) * (max - min));
      paint();
    });
    k.addEventListener("pointerup", () => { startY = null; save(); });
    k.addEventListener("pointercancel", () => { startY = null; });
    k.addEventListener("dblclick", () => { pushState(); set(min + (max - min) / 2); paint(); save(); });
    k.addEventListener("keydown", (e) => {
      const step = (max - min) / (e.shiftKey ? 10 : 40);
      if (e.key === "ArrowUp" || e.key === "ArrowRight") { pushStateGesture(gestureKey); set(Math.min(max, get() + step)); }
      else if (e.key === "ArrowDown" || e.key === "ArrowLeft") { pushStateGesture(gestureKey); set(Math.max(min, get() - step)); }
      else return;
      e.preventDefault(); e.stopPropagation(); paint(); save();
    });
    k.addEventListener("wheel", (e) => { e.preventDefault(); pushStateGesture(gestureKey); set(Math.max(min, Math.min(max, get() - Math.sign(e.deltaY) * (max - min) / 40))); paint(); save(); }, { passive: false });
    wrap.append(k, el("span", "daw-knob-label", label), read);
    paint();
    return wrap;
  }

  const fmtHz = (v) => (v >= 1000 ? (v / 1000).toFixed(1) + " kHz" : Math.round(v) + " Hz");
  const fmtDb = (v) => (v > 0 ? "+" : "") + v.toFixed(1) + " dB";

  function renderChain() {
    const p = el_.chain;
    const t = activeTrack();
    p.innerHTML = "";
    const head = el("div", "daw-panel-head");
    head.append(el("span", "daw-chain-track", t ? t.name : "—"), el("span", "daw-panel-title", "DEVICE CHAIN"));
    const close = iconBtn("daw-hbtn", "×", "Hide device chain");
    close.addEventListener("click", () => toggleBottomPanel("chain"));
    head.appendChild(close);
    p.appendChild(head);
    if (!t) return;

    const body = el("div", "daw-chain-body");

    // mini mixer strip
    const mix = el("div", "daw-mixstrip");
    const mkT = (cls, txt, on, fn, label) => {
      const b = iconBtn("daw-hbtn " + cls, txt, label);
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", on ? "true" : "false");
      b.addEventListener("click", fn);
      return b;
    };
    const fader = el("input", "daw-fader");
    fader.type = "range"; fader.min = 0; fader.max = 1.4; fader.step = 0.01; fader.value = t.gain;
    fader.setAttribute("aria-label", `${t.name} volume`);
    fader.addEventListener("pointerdown", pushState);
    fader.addEventListener("keydown", (e) => {
      if (/^(Arrow|Home$|End$|Page)/.test(e.key)) pushStateGesture("fader:" + t.id);
    });
    fader.addEventListener("input", () => { t.gain = +fader.value; engine.refreshTrackParams(); save(); });
    const meter = el("div", "daw-meter"); meter.id = "daw-meter"; meter.appendChild(el("i"));
    const mrow = el("div", "daw-mix-btns");
    mrow.append(
      mkT("daw-mute", "MUTE", t.mute, () => { pushState(); t.mute = !t.mute; engine.refreshTrackParams(); renderHeads(); renderChain(); save(); }, `Mute ${t.name}`),
      mkT("daw-solo", "SOLO", t.solo, () => { pushState(); t.solo = !t.solo; engine.refreshTrackParams(); renderHeads(); renderChain(); save(); }, `Solo ${t.name}`),
    );
    const pankn = knob("Pan", () => t.pan, (v) => { t.pan = v; engine.refreshTrackParams(); }, {
      min: -1, max: 1, fmt: (v) => (Math.abs(v) < 0.02 ? "C" : (v < 0 ? "L" : "R") + Math.round(Math.abs(v) * 100)),
    });
    mix.append(mrow, fader, pankn, meter);
    body.appendChild(mix);

    // instrument / source card
    const inst = el("div", "daw-device daw-instrument");
    const instHead = el("div", "daw-device-head");
    instHead.append(el("strong", null, t.kind === "audio" ? "Audio In" : t.kind === "drums" ? "Drum Kit" : "Synth"));
    inst.appendChild(instHead);
    const instBody = el("div", "daw-device-body");
    if (t.kind === "midi") {
      const sel = el("select", "daw-dev-sel");
      Object.keys(FACTORY_PATCHES[t.family]).forEach((id) => {
        const o = el("option", null, SOUND_LABELS[t.family]?.[id] || id);
        o.value = id; if (id === t.sound) o.selected = true;
        sel.appendChild(o);
      });
      sel.setAttribute("aria-label", "Instrument sound");
      sel.addEventListener("change", () => { pushState(); t.sound = sel.value; renderHeads(); save(); });
      instBody.appendChild(sel);
    } else if (t.kind === "drums") {
      const sel = el("select", "daw-dev-sel");
      Object.entries(KIT_LABELS).forEach(([id, l]) => { const o = el("option", null, l); o.value = id; if (id === t.kit) o.selected = true; sel.appendChild(o); });
      sel.setAttribute("aria-label", "Drum kit");
      sel.addEventListener("change", () => { pushState(); t.kit = sel.value; renderHeads(); save(); });
      instBody.appendChild(sel);
    } else {
      const sel = el("select", "daw-dev-sel");
      const dflt = el("option", null, inputDevices.length ? "Default input" : "Arm to pick an input…");
      dflt.value = ""; sel.appendChild(dflt);
      inputDevices.forEach((d, i) => { const o = el("option", null, d.label || `Input ${i + 1}`); o.value = d.deviceId; if (d.deviceId === t.inputId) o.selected = true; sel.appendChild(o); });
      sel.setAttribute("aria-label", "Audio input device");
      sel.addEventListener("change", () => { t.inputId = sel.value || null; save(); });
      const monBtn = iconBtn("daw-hbtn daw-mon", "🎧", `Live Input Monitor: ${t.monitor ? "ON" : "OFF"}`);
      monBtn.classList.toggle("active", !!t.monitor);
      monBtn.addEventListener("click", () => { pushState(); t.monitor = !t.monitor; renderChain(); save(); _toast(t.monitor ? "Live monitoring ON" : "Live monitoring OFF"); });
      const imp = el("button", "daw-fbtn", "Import audio file");
      imp.type = "button";
      imp.addEventListener("click", () => importAudioFile(t));
      instBody.append(sel, monBtn, imp);
    }
    inst.appendChild(instBody);
    body.appendChild(inst);

    // EQ card
    const fx = t.fx || (t.fx = DEFAULT_FX());
    const eq = el("div", "daw-device daw-effect");
    const eqHead = el("div", "daw-device-head");
    const eqPow = mkT("daw-pow", "⏻", fx.eq.on !== false, () => { pushState(); fx.eq.on = fx.eq.on === false; engine.refreshTrackParams(); renderChain(); save(); }, "Equalizer on/off");
    eqHead.append(eqPow, el("strong", null, "Equalizer"));
    const eqBody = el("div", "daw-device-body daw-knobs");
    const eqSet = (fn) => (v) => { fn(v); engine.refreshTrackParams(); };
    eqBody.append(
      knob("HPF Freq", () => fx.eq.hp, eqSet((v) => (fx.eq.hp = v)), { min: 20, max: 1000, fmt: fmtHz }),
      knob("Peak Freq", () => fx.eq.peakF, eqSet((v) => (fx.eq.peakF = v)), { min: 80, max: 12000, fmt: fmtHz }),
      knob("Peak Gain", () => fx.eq.peakG, eqSet((v) => (fx.eq.peakG = v)), { min: -18, max: 18, fmt: fmtDb }),
      knob("Peak Q", () => fx.eq.peakQ, eqSet((v) => (fx.eq.peakQ = v)), { min: 0.2, max: 8, fmt: (v) => v.toFixed(1) }),
      knob("LPF Freq", () => fx.eq.lp, eqSet((v) => (fx.eq.lp = v)), { min: 400, max: 20000, fmt: fmtHz }),
    );
    eq.append(eqHead, eqBody);
    eq.classList.toggle("off", fx.eq.on === false);
    body.appendChild(eq);

    // Compressor card
    const compFx = fx.compressor || (fx.compressor = DEFAULT_FX().compressor);
    const compEl = el("div", "daw-device daw-effect");
    const compHead = el("div", "daw-device-head");
    const compPow = mkT("daw-pow", "⏻", compFx.on !== false, () => { pushState(); compFx.on = compFx.on === false; engine.refreshTrackParams(); renderChain(); save(); }, "Compressor on/off");
    compHead.append(compPow, el("strong", null, "Compressor"));
    const compBody = el("div", "daw-device-body daw-knobs");
    const compSet = (fn) => (v) => { fn(v); engine.refreshTrackParams(); };
    compBody.append(
      knob("Thresh", () => compFx.thresh ?? -24, compSet((v) => (compFx.thresh = v)), { min: -60, max: 0, fmt: fmtDb }),
      knob("Ratio", () => compFx.ratio ?? 4, compSet((v) => (compFx.ratio = v)), { min: 1, max: 20, fmt: (v) => v.toFixed(1) + ":1" }),
      knob("Attack", () => (compFx.attack ?? 0.01) * 1000, compSet((v) => (compFx.attack = v / 1000)), { min: 1, max: 500, fmt: (v) => Math.round(v) + " ms" }),
      knob("Release", () => (compFx.release ?? 0.25) * 1000, compSet((v) => (compFx.release = v / 1000)), { min: 10, max: 1000, fmt: (v) => Math.round(v) + " ms" }),
    );
    compEl.append(compHead, compBody);
    compEl.classList.toggle("off", compFx.on === false);
    body.appendChild(compEl);

    // Delay card
    const delFx = fx.delay || (fx.delay = DEFAULT_FX().delay);
    const delEl = el("div", "daw-device daw-effect");
    const delHead = el("div", "daw-device-head");
    const delPow = mkT("daw-pow", "⏻", delFx.on !== false, () => { pushState(); delFx.on = delFx.on === false; engine.refreshTrackParams(); renderChain(); save(); }, "Delay on/off");
    delHead.append(delPow, el("strong", null, "Delay / Echo"));
    const delBody = el("div", "daw-device-body daw-knobs");
    const delSet = (fn) => (v) => { fn(v); engine.refreshTrackParams(); };
    delBody.append(
      knob("Time", () => delFx.time ?? 0.25, delSet((v) => (delFx.time = v)), { min: 0.0625, max: 2, fmt: (v) => v.toFixed(2) + " beats" }),
      knob("Feedback", () => delFx.feedback ?? 0.3, delSet((v) => (delFx.feedback = v)), { min: 0, max: 0.88, fmt: (v) => Math.round(v * 100) + "%" }),
      knob("Mix", () => delFx.mix ?? 0, delSet((v) => (delFx.mix = v)), { min: 0, max: 1, fmt: (v) => Math.round(v * 100) + "%" }),
    );
    delEl.append(delHead, delBody);
    delEl.classList.toggle("off", delFx.on === false);
    body.appendChild(delEl);

    // Distortion card
    const distFx = fx.distortion || (fx.distortion = DEFAULT_FX().distortion);
    const distEl = el("div", "daw-device daw-effect");
    const distHead = el("div", "daw-device-head");
    const distPow = mkT("daw-pow", "⏻", distFx.on !== false, () => { pushState(); distFx.on = distFx.on === false; engine.refreshTrackParams(); renderChain(); save(); }, "Distortion on/off");
    distHead.append(distPow, el("strong", null, "Distortion / Drive"));
    const distBody = el("div", "daw-device-body daw-knobs");
    const distSet = (fn) => (v) => { fn(v); engine.refreshTrackParams(); };
    distBody.append(
      knob("Drive", () => distFx.drive ?? 0.2, distSet((v) => (distFx.drive = v)), { min: 0, max: 1, fmt: (v) => Math.round(v * 100) + "%" }),
      knob("Mix", () => distFx.mix ?? 0.5, distSet((v) => (distFx.mix = v)), { min: 0, max: 1, fmt: (v) => Math.round(v * 100) + "%" }),
    );
    distEl.append(distHead, distBody);
    distEl.classList.toggle("off", distFx.on === false);
    body.appendChild(distEl);

    // Reverb card
    const rv = el("div", "daw-device daw-effect");
    const rvHead = el("div", "daw-device-head");
    const rvPow = mkT("daw-pow", "⏻", fx.reverb.on !== false, () => { pushState(); fx.reverb.on = fx.reverb.on === false; engine.refreshTrackParams(); renderChain(); save(); }, "Reverb on/off");
    rvHead.append(rvPow, el("strong", null, "Reverb"));
    const rvBody = el("div", "daw-device-body daw-knobs");
    let rvRebuild = null;
    const rvSet = (fn, rebuild) => (v) => {
      fn(v);
      if (rebuild) { clearTimeout(rvRebuild); rvRebuild = setTimeout(() => engine.rebuildTrack(t.id), 300); }
      else engine.refreshTrackParams();
    };
    rvBody.append(
      knob("Size", () => fx.reverb.size, rvSet((v) => (fx.reverb.size = v), true)),
      knob("Damp", () => fx.reverb.damp, rvSet((v) => (fx.reverb.damp = v), true)),
      knob("Mix", () => fx.reverb.mix, rvSet((v) => (fx.reverb.mix = v))),
    );
    rv.append(rvHead, rvBody);
    rv.classList.toggle("off", fx.reverb.on === false);
    body.appendChild(rv);
    // Sticky right-edge fade — signals more devices are off-screen.
    body.appendChild(el("div", "daw-chain-fade"));

    p.appendChild(body);
  }

  /* ---------------- import / export / deck ---------------- */
  async function importAudioBlob(t, file, startBeat) {
    try {
      const buf = await _getCtx().decodeAudioData(await file.arrayBuffer());
      pushState();
      const clipId = CLIP_PREFIX + Date.now();
      clips.set(clipId, buf);
      let stored = false;
      try {
        stored = await saveSample(clipId, file.name, buf, { pinned: true });
      } catch {}
      const lenB = Math.max(snapStep, snap(buf.duration * (song.bpm / 60)));
      const r = makeRegion(t, snap(startBeat), lenB, { name: file.name.replace(/\.[^.]+$/, ""), clipId });
      if (!stored) r.volatile = true;
      activeTrackId = t.id;
      selRegion = { trackId: t.id, regionId: r.id };
      renderAll();
      save();
      if (stored) {
        _toast(`Imported ${file.name}`, { severity: "ok" });
      } else {
        _toast(
          `${file.name} is available for this session, but browser storage could not save it. Export before closing this tab.`,
          { severity: "error", duration: 8000 },
        );
      }
      return r;
    } catch {
      _toast("Could not decode that audio file.", { severity: "error" });
      return null;
    }
  }

  function importAudioFile(t) {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "audio/*";
    input.addEventListener("change", async () => {
      const f = input.files[0];
      if (!f) return;
      await importAudioBlob(t, f, engine.beatNow());
    });
    input.click();
  }

  async function bounce() {
    const end = songEnd();
    if (end <= 0) { _toast("Nothing to render yet"); return null; }
    return engine.renderOffline(0, end);
  }

  async function sendToDeck(deck) {
    _toast("Rendering…");
    try {
      const buf = await bounce();
      if (!buf) return;
      const cues = [...new Set(song.tracks.flatMap((t) => t.regions.map((r) => r.start)))].sort((a, b) => a - b)
        .slice(0, 8).map((b) => (b * (60 / song.bpm)) / buf.duration);
      _onUse(buf, `daw · ${song.bpm} BPM`, deck, song.bpm, cues);
      _toast(`Loaded onto Deck ${deck}.`, { severity: "ok" });
    } catch (e) {
      console.warn(e);
      _toast("Could not render the song.", { severity: "error" });
    }
  }

  async function downloadWav() {
    _toast("Rendering…");
    try {
      const buf = await bounce();
      if (!buf) return;
      const url = URL.createObjectURL(bufferToWav(buf));
      const a = document.createElement("a");
      a.href = url; a.download = "sxratch-pad-song.wav"; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      _toast("Downloaded your song as WAV.", { severity: "ok" });
    } catch (e) {
      console.warn(e);
      _toast("Could not render the song.", { severity: "error" });
    }
  }

  function exportJson() {
    const blob = new Blob([JSON.stringify({ v: SCHEMA_V, song }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `sxratch-daw-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    _toast("Song exported as a JSON file (audio clips stay in this browser).", { severity: "ok" });
  }

  function importJson() {
    const input = document.createElement("input");
    input.type = "file"; input.accept = ".json";
    input.addEventListener("change", () => {
      const f = input.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const parsed = JSON.parse(ev.target.result);
          const sg = normalizeSong(parsed && parsed.song);
          if (!sg) { _toast("Invalid song file structure.", { severity: "error" }); return; }
          pushState();
          song = sg;
          afterHistoryJump();
          _toast("Song imported — Ctrl+Z to undo.");
        } catch {
          _toast("Could not read that song file.", { severity: "error" });
        }
      };
      reader.readAsText(f);
    });
    input.click();
  }

  function newSong() {
    pushState();
    song = defaultSong();
    const t = makeTrack("midi", { family: "chord" });
    song.tracks.push(t);
    activeTrackId = t.id;
    selRegion = null;
    closeEditor();
    renderAll(); save();
    _toast("New song — Ctrl+Z brings the old one back.");
  }

  /* ---------------- boot ---------------- */
  async function loadClips() {
    let loadFailed = false;
    try {
      const all = await loadAllSamples();
      const ctx = _getCtx();
      for (const rec of all || []) {
        // idb-store persists raw channel data, not AudioBuffers — rebuild one.
        if (!rec.id || !rec.id.startsWith(CLIP_PREFIX)) continue;
        if (!Array.isArray(rec.channels) || !rec.channels.length || !rec.channels[0].length) continue;
        const buf = ctx.createBuffer(rec.channels.length, rec.channels[0].length, rec.sampleRate || ctx.sampleRate);
        rec.channels.forEach((ch, i) => buf.getChannelData(i).set(ch));
        clips.set(rec.id, buf);
      }
    } catch {
      loadFailed = true;
    }
    // Drop clips no region references (garbage from deleted takes).
    const used = new Set(song.tracks.flatMap((t) => t.regions.map((r) => r.clipId).filter(Boolean)));
    for (const id of clips.keys()) {
      if (!used.has(id)) { clips.delete(id); deleteSample(id).catch(() => {}); }
    }
    const missing = [...used].filter((id) => !clips.has(id));
    if (loadFailed || missing.length) {
      _toast(
        missing.length
          ? `${missing.length} audio ${missing.length === 1 ? "clip is" : "clips are"} unavailable in browser storage. Re-import the source audio before exporting.`
          : "Browser storage could not be read, so saved audio clips are unavailable.",
        { severity: "error", duration: 8000 },
      );
    }
    renderTimeline();
  }

  function init(deps) {
    _getCtx = deps.getCtx;
    _toast = deps.toast || _toast;
    _onUse = deps.onUse || _onUse;
    _getSampler = deps.getSampler || _getSampler;
    root = document.getElementById("song-builder");

    song = normalizeSong(readVersioned(STORE_KEY, SCHEMA_V, MIGRATIONS));
    if (song) {
      idc = Math.max(1, ...song.tracks.map((t) => t.id), ...song.tracks.flatMap((t) => t.regions.map((r) => r.id)), 0) + 1;
      activeTrackId = song.tracks[0]?.id ?? null;
    } else {
      const old = readVersioned("sxratch.song", 1, [(s) => s]);
      song = migrateOldSong(old);
      if (song) _toast("Imported your song-builder project into the new studio.", { severity: "ok" });
      else song = starterSong();
      normalizeSong(song);
      save();
    }
    snapStep = nearestSnap(song.view?.snap);
    pxPerBeat = Math.max(6, Math.min(80, +song.view?.zoom || 26));
    followPlayhead = song.view?.follow !== false;
    loadBottomState();

    engine = createDawEngine({
      getCtx: _getCtx,
      getOutput: deps.getOutput,
      getSong: () => song,
      getClip: (id) => clips.get(id),
      onPlayhead: () => {},
      onRecordFail: (m) => _toast(m, { severity: "error" }),
    });

    buildShell();
    renderAll();
    loadClips();

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("resize", applyPanels);
    if (!rafId) rafLoop();

    // Debug handle (same convention as window.sxratch on the deck side) —
    // used by tests/automation, harmless in production.
    window.sxdaw = { get engine() { return engine; }, get song() { return song; }, get clips() { return clips; } };
  }

  async function stopPreview() {
    if (engine?.recording) await finishRecording();
    else engine?.stop();
    if (el_.playBtn) updateTransportButtons();
  }

  /** Hardware MIDI in (routed from app.js) → active track. */
  function midiNote(note, vel = 1, on = true) {
    const t = activeTrack();
    if (!t || !engine) return;
    if (on) engine.noteOn(t, note, vel);
    else engine.noteOff(t, note);
  }

  return { init, stopPreview, midiNote };
})();
