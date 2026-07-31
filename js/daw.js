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
import { readVersioned, readVersionedRecord, writeVersioned } from "./store.js";
import {
  saveSample,
  loadAllSamples,
  deleteSample,
  loadDawSong,
  saveDawSong,
  listDawRecoveries,
  restoreDawRecovery,
  collectDawClipIds,
  shouldPreferDawFallback,
} from "./idb-store.js";
import {
  DEFAULT_SNAP,
  MIN_SNAP,
  SNAP_OPTIONS,
  buildRegionClipboard,
  clampFinite,
  clampedFade,
  duplicateRegion,
  formatMusicalPosition,
  materializeRegionClipboard,
  nearestSnap,
  quantizeBeat,
  resizeSelectedNotes,
  shiftSelectedNotes,
  splitRegionContent,
  trimRegionStartContent,
  quantizeRegionNotes,
  transposeRegionNotes,
} from "./daw-model.js";
import {
  createGuidedTour,
  shortcutGroupsForDisplay,
} from "./daw-guidance.js";

export const DAW = (() => {
  /* ---------------- deps (from app.js) ---------------- */
  let _getCtx = () => { throw new Error("DAW not initialised"); };
  let _toast = () => {};
  let _onUse = () => {};
  let _getSampler = () => null;

  /* ---------------- constants ---------------- */
  const STORE_KEY = "sxratch.daw";
  const SCHEMA_V = 4;
  const MIGRATIONS = [
    (s) => s,
    (s) => ({ ...s, view: { snap: DEFAULT_SNAP, zoom: 26, follow: true, ...(s?.view || {}) } }),
    (s) => ({
      ...s,
      master: s?.master || { gain: 0.9, eq: { on: true, low: 0, mid: 0, high: 0 } },
      buses: s?.buses || {
        reverb: { on: true, size: 0.4, damp: 0.5, return: 1 },
        delay: { on: true, time: 0.25, feedback: 0.3, tone: 2600, return: 1 },
      },
      tracks: (s?.tracks || []).map((t) => ({
        ...t,
        sends: t.sends || {
          reverb: t.fx?.reverb?.on === false ? 0 : (+t.fx?.reverb?.mix || 0),
          delay: t.fx?.delay?.on === false ? 0 : (+t.fx?.delay?.mix || 0),
        },
        automation: t.automation || { gain: [], pan: [], reverb: [], delay: [] },
      })),
    }),
    (s) => ({
      ...s,
      markers: Array.isArray(s?.markers) ? s.markers : [],
      view: { ...(s?.view || {}), openTakeTrackIds: s?.view?.openTakeTrackIds || [] },
      tracks: (s?.tracks || []).map((t) => ({
        ...t,
        takeLanes: Array.isArray(t.takeLanes) ? t.takeLanes : [],
        comp: Array.isArray(t.comp) ? t.comp : [],
      })),
    }),
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
  const DEFAULT_MASTER = () => ({ gain: 0.9, eq: { on: true, low: 0, mid: 0, high: 0 } });
  const DEFAULT_BUSES = () => ({
    reverb: { on: true, size: 0.4, damp: 0.5, return: 1 },
    delay: { on: true, time: 0.25, feedback: 0.3, tone: 2600, return: 1 },
  });
  const DEFAULT_SENDS = () => ({ reverb: 0, delay: 0 });
  const DEFAULT_AUTOMATION = () => ({ gain: [], pan: [], reverb: [], delay: [] });
  const AUTO_SPEC = Object.freeze({
    gain: { label: "Volume", min: 0, max: 1.4 },
    pan: { label: "Pan", min: -1, max: 1 },
    reverb: { label: "Reverb send", min: 0, max: 1 },
    delay: { label: "Delay send", min: 0, max: 1 },
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
  let sel = [];                            // [{trackId, regionId}] — [0] is primary
  let clipboard = null;                    // region clipboard (in-memory)
  let selectedMarkerId = null;
  let editRegion = null;                   // region open in the editor panel
  let rollSel = new Set();                 // selected note/hit objects in the roll
  let lastNoteLen = 0.5;                   // sticky length for newly drawn notes
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
  let saveState = "saved";
  let lastIdbRevision = null;
  let timelineRefreshFrame = 0;
  let reverbRebuildTimer = null;
  let dawTour = null;
  let tourScrollHandler = null;

  const $ = (s) => root.querySelector(s);
  const beatsPerBar = () => (song.ts.num * 4) / song.ts.den;
  const activeTrack = () => song.tracks.find((t) => t.id === activeTrackId) || song.tracks[0] || null;
  const trackById = (id) => song.tracks.find((t) => t.id === id);
  const regionById = (t, id) => t && (t.regions || []).find((r) => r.id === id);
  const songEnd = () => Math.max(
    8 * beatsPerBar(),
    ...song.tracks.flatMap((t) => (t.regions || []).map((r) => r.start + r.len)),
    ...song.tracks.flatMap((t) => Object.values(t.automation || {}).flatMap((points) => (points || []).map((p) => p.b))),
    ...(song.markers || []).map((m) => m.beat)
  );
  const snap = (b, mode = "round") => quantizeBeat(b, snapStep, mode);
  const snapBar = (b) => Math.round(b / beatsPerBar()) * beatsPerBar();
  const gridStep = () => (snapStep > 0 ? snapStep : DEFAULT_SNAP);  // for default lengths
  const minLen = () => (snapStep > 0 ? snapStep : MIN_SNAP);        // resize/draw floor

  /* ---------------- region selection (multi) ---------------- */
  const selHas = (regionId) => sel.some((s) => s.regionId === regionId);
  const primarySel = () => sel[0] || null;
  /** Resolve selection to live {track, region} pairs, pruning stale entries. */
  function selectedRegions() {
    const out = [];
    for (const s of sel) {
      const track = trackById(s.trackId);
      const region = regionById(track, s.regionId);
      if (track && region) out.push({ track, region });
    }
    return out;
  }
  function pruneSelection() {
    sel = sel.filter((s) => regionById(trackById(s.trackId), s.regionId));
  }
  /** Sync .sel classes on rendered region elements without a rebuild. */
  function syncSelClasses() {
    el_.lanes?.querySelectorAll(".daw-region").forEach((x) => {
      const selected = selHas(+x.dataset.region);
      x.classList.toggle("sel", selected);
      x.setAttribute("aria-selected", selected ? "true" : "false");
    });
    syncStatus();
  }

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
    idc = Math.max(idc, maxSongId(song) + 1);
    if (!trackById(activeTrackId)) activeTrackId = song.tracks[0]?.id ?? null;
    pruneSelection();
    rollSel = new Set();       // note identities do not survive the JSON round trip
    // Keep the editor open across undo when its region still exists — the roll
    // is an editing surface now, and Ctrl+Z mid-edit must not slam it shut.
    if (editRegion) {
      const keepId = editRegion.id;
      editRegion = null;
      for (const t of song.tracks) {
        const r = regionById(t, keepId);
        if (r) { editRegion = r; break; }
      }
      if (!editRegion) closeEditor();
    }
    engine?.syncGraph?.();
    engine?.refreshMixParams?.();
    engine?.refreshTrackParams();
    renderAll();
    save();
  }
  function save() {
    clearTimeout(_saveTimer);
    saveState = "saving";
    syncSaveStatus();
    _saveTimer = setTimeout(() => persistSong("autosave"), 250);
  }

  async function persistSong(reason = "autosave") {
    clearTimeout(_saveTimer);
    _saveTimer = null;
    const snapshot = JSON.parse(JSON.stringify(song));
    let idbOk = false;
    let savedRecord = null;
    try {
      savedRecord = await saveDawSong("current", SCHEMA_V, snapshot, { reason });
      idbOk = !!savedRecord;
      if (Number.isInteger(savedRecord?.revision)) lastIdbRevision = savedRecord.revision;
    } catch {}
    const metadata = idbOk
      ? null
      : {
          dawFallback: {
            failedAt: Date.now(),
            baseRevision: Number.isInteger(lastIdbRevision) ? lastIdbRevision : null,
          },
        };
    const localOk = writeVersioned(STORE_KEY, SCHEMA_V, snapshot, {
      onQuota: () => {},
      metadata,
    });
    saveState = idbOk ? "saved" : localOk ? "fallback" : "error";
    syncSaveStatus();
    if (!idbOk && !localOk) {
      _toast("Could not save — browser storage is full.", { severity: "error" });
    }
    return idbOk || localOk;
  }

  function syncSaveStatus() {
    if (!el_.saveRead) return;
    const label = {
      saving: "Saving…",
      saved: "Saved",
      fallback: "Saved locally",
      error: "Save failed",
    }[saveState] || "Saved";
    el_.saveRead.textContent = label;
    el_.saveRead.dataset.state = saveState;
  }

  /* ---------------- model factories ---------------- */
  function makeTrack(kind, opts = {}) {
    const n = song ? song.tracks.length : 0;
    const base = {
      id: idc++, kind,
      name: opts.name || (kind === "audio" ? "Audio" : kind === "drums" ? "Drums" : (opts.family === "bass" ? "Bass" : opts.family === "lead" ? "Lead" : "Chords")),
      color: opts.color ?? n % TRACK_COLORS.length,
      gain: 0.9, pan: 0, mute: false, solo: false, armed: false,
      fx: DEFAULT_FX(),
      sends: DEFAULT_SENDS(),
      automation: DEFAULT_AUTOMATION(),
      automationParam: "gain",
      automationVisible: false,
      takeLanes: [],
      comp: [],
      regions: [],
    };
    if (kind === "midi") { base.family = opts.family || "chord"; base.sound = opts.sound || Object.keys(FACTORY_PATCHES[base.family])[0]; base.patch = {}; }
    if (kind === "drums") base.kit = opts.kit || "acoustic";
    if (kind === "audio") base.inputId = null;
    return base;
  }
  function makeRegion(track, start, len, opts = {}) {
    const r = { id: idc++, name: opts.name || "New Region", start, len };
    if (track.kind === "audio") {
      r.clipId = opts.clipId || null;
      r.offset = opts.offset || 0;
      r.gain = 1;
      r.sourceBpm = opts.sourceBpm || song?.bpm || 120;
      r.tempoMode = opts.tempoMode || "repitch";
    }
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
      master: DEFAULT_MASTER(),
      buses: DEFAULT_BUSES(),
      markers: [],
      view: { snap: DEFAULT_SNAP, zoom: 26, follow: true, openTakeTrackIds: [] },
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
      zoom: Math.max(6, Math.min(160, +sg.view?.zoom || 26)),
      follow: sg.view?.follow !== false,
      openTakeTrackIds: Array.isArray(sg.view?.openTakeTrackIds)
        ? sg.view.openTakeTrackIds.map(Number).filter(Number.isFinite)
        : [],
    };
    sg.master = { ...DEFAULT_MASTER(), ...(sg.master || {}) };
    sg.master.gain = clampFinite(sg.master.gain, 0, 1.4, 0.9);
    sg.master.eq = { ...DEFAULT_MASTER().eq, ...(sg.master.eq || {}) };
    sg.master.eq.on = sg.master.eq.on !== false;
    for (const band of ["low", "mid", "high"]) sg.master.eq[band] = clampFinite(sg.master.eq[band], -18, 18, 0);
    sg.buses = { ...DEFAULT_BUSES(), ...(sg.buses || {}) };
    sg.buses.reverb = { ...DEFAULT_BUSES().reverb, ...(sg.buses.reverb || {}) };
    sg.buses.delay = { ...DEFAULT_BUSES().delay, ...(sg.buses.delay || {}) };
    sg.buses.reverb.on = sg.buses.reverb.on !== false;
    sg.buses.reverb.size = clampFinite(sg.buses.reverb.size, 0, 1, 0.4);
    sg.buses.reverb.damp = clampFinite(sg.buses.reverb.damp, 0, 1, 0.5);
    sg.buses.reverb.return = clampFinite(sg.buses.reverb.return, 0, 1.4, 1);
    sg.buses.delay.on = sg.buses.delay.on !== false;
    sg.buses.delay.time = clampFinite(sg.buses.delay.time, 0.0625, 2, 0.25);
    sg.buses.delay.feedback = clampFinite(sg.buses.delay.feedback, 0, 0.88, 0.3);
    sg.buses.delay.tone = clampFinite(sg.buses.delay.tone, 200, 16000, 2600);
    sg.buses.delay.return = clampFinite(sg.buses.delay.return, 0, 1.4, 1);
    sg.markers = (Array.isArray(sg.markers) ? sg.markers : [])
      .filter((m) => m && Number.isFinite(+m.beat))
      .map((m) => ({
        id: +m.id || idc++,
        beat: Math.max(0, +m.beat),
        name: String(m.name || "Section").slice(0, 32),
        color: (+m.color || 0) % TRACK_COLORS.length,
      }))
      .sort((a, b) => a.beat - b.beat);
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
      t.fx.bypass = !!t.fx.bypass;
      t.sends = {
        ...DEFAULT_SENDS(),
        reverb: t.sends?.reverb ?? (t.fx.reverb.on === false ? 0 : t.fx.reverb.mix),
        delay: t.sends?.delay ?? (t.fx.delay.on === false ? 0 : t.fx.delay.mix),
      };
      t.sends.reverb = clampFinite(t.sends.reverb, 0, 1, 0);
      t.sends.delay = clampFinite(t.sends.delay, 0, 1, 0);
      t.automation = { ...DEFAULT_AUTOMATION(), ...(t.automation || {}) };
      for (const [key, spec] of Object.entries(AUTO_SPEC)) {
        const byBeat = new Map();
        for (const point of Array.isArray(t.automation[key]) ? t.automation[key] : []) {
          if (!point || !Number.isFinite(+point.b) || !Number.isFinite(+point.v)) continue;
          const b = Math.max(0, +point.b);
          byBeat.set(b, { id: +point.id || idc++, b, v: clampFinite(point.v, spec.min, spec.max, spec.min) });
        }
        t.automation[key] = [...byBeat.values()].sort((a, b) => a.b - b.b);
      }
      t.automationParam = AUTO_SPEC[t.automationParam] ? t.automationParam : "gain";
      t.automationVisible = !!t.automationVisible;
      t.takeLanes = Array.isArray(t.takeLanes) ? t.takeLanes : [];
      t.comp = Array.isArray(t.comp) ? t.comp : [];
      t.regions = (Array.isArray(t.regions) ? t.regions : []).filter((r) => r && typeof r === "object");
      for (const r of t.regions) {
        r.id = +r.id || idc++;
        r.start = Math.max(0, +r.start || 0);
        r.len = Math.max(MIN_SNAP, +r.len || MIN_SNAP);
        if (t.kind === "audio") {
          r.offset = Math.max(0, +r.offset || 0);
          r.gain = clampFinite(r.gain, 0, 4, 1);
          r.sourceBpm = clampFinite(r.sourceBpm, 40, 240, sg.bpm);
          r.tempoMode = r.tempoMode === "repitch" ? "repitch" : "raw";
        }
        else if (t.kind === "drums") r.hits = Array.isArray(r.hits) ? r.hits.filter((h) => h && DRUM_LABELS[h.k]) : [];
        else r.notes = Array.isArray(r.notes) ? r.notes.filter((n) => n && n.m >= 0 && n.m <= 127) : [];
      }
      normalizeTakeGroups(t);
    }
    sg.v = SCHEMA_V;
    return sg;
  }

  function normalizeTakeGroups(track) {
    const groups = new Map();
    for (const r of track.regions || []) {
      if (r.takeGroup == null) continue;
      r.takeGroup = String(r.takeGroup);
      r.takeNo = Math.max(1, +r.takeNo || 1);
      if (!groups.has(r.takeGroup)) groups.set(r.takeGroup, []);
      groups.get(r.takeGroup).push(r);
    }
    for (const takes of groups.values()) {
      takes.sort((a, b) => a.takeNo - b.takeNo);
      const active = takes.find((r) => r.takeActive !== false) || takes[takes.length - 1];
      const activeNo = active.takeNo;
      for (const r of takes) r.takeActive = r.takeNo === activeNo;
    }
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
    engine?.refreshMixParams?.();
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

  function buildShortcutOverlay() {
    root.querySelector("#daw-shortcut-dialog")?.remove();
    const dialog = el("dialog", "daw-shortcut-dialog");
    dialog.id = "daw-shortcut-dialog";
    dialog.setAttribute("aria-labelledby", "daw-shortcut-title");
    const head = el("header", "daw-shortcut-head");
    const title = el("h2", null, "Studio shortcuts");
    title.id = "daw-shortcut-title";
    const close = iconBtn("daw-hbtn", "×", "Close shortcuts");
    close.addEventListener("click", () => dialog.close());
    head.append(title, close);
    const groups = el("div", "daw-shortcut-groups");
    for (const group of shortcutGroupsForDisplay({ compact: true })) {
      const section = el("section", "daw-shortcut-group");
      section.appendChild(el("h3", null, group.title));
      const dl = el("dl");
      for (const shortcut of group.shortcuts) {
        const row = el("div", "daw-shortcut-row");
        row.append(el("dt", null, shortcut.title), el("dd", null, shortcut.label || "—"));
        dl.appendChild(row);
      }
      section.appendChild(dl);
      groups.appendChild(section);
    }
    const tour = el("button", "daw-fbtn daw-shortcut-tour", "Restart guided tour");
    tour.type = "button";
    tour.addEventListener("click", () => { dialog.close(); startDawTour(true); });
    dialog.append(head, groups, tour);
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog.close();
    });
    root.appendChild(dialog);
  }

  function showShortcutOverlay() {
    const dialog = root?.querySelector("#daw-shortcut-dialog");
    if (!dialog) return;
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function ensureDawTour() {
    if (dawTour) return dawTour;
    dawTour = createGuidedTour({
      root: () => root,
      onChange: renderDawTour,
    });
    return dawTour;
  }

  function startDawTour(restart = false) {
    const tour = ensureDawTour();
    tour.start({ restart });
  }

  function renderDawTour(state) {
    root?.querySelector("#daw-tour-layer")?.remove();
    if (!state.active || !state.step || !state.target) {
      if (tourScrollHandler) {
        window.removeEventListener("resize", tourScrollHandler);
        window.removeEventListener("scroll", tourScrollHandler, true);
        tourScrollHandler = null;
      }
      return;
    }
    const layer = el("div", "daw-tour-layer");
    layer.id = "daw-tour-layer";
    const focus = el("div", "daw-tour-focus");
    const card = el("section", "daw-tour-card");
    card.setAttribute("role", "dialog");
    card.setAttribute("aria-modal", "true");
    card.setAttribute("aria-labelledby", "daw-tour-step-title");
    const eyebrow = el("span", "daw-tour-count", `${state.index + 1} / ${state.total}`);
    const title = el("h2", null, state.step.title);
    title.id = "daw-tour-step-title";
    const copy = el("p", null, state.step.body);
    const actions = el("div", "daw-tour-actions");
    const back = el("button", "daw-fbtn", "Back");
    back.type = "button"; back.disabled = !state.canGoBack;
    back.addEventListener("click", () => dawTour.previous());
    const pause = el("button", "daw-fbtn", "Not now");
    pause.type = "button"; pause.addEventListener("click", () => dawTour.pause());
    const skip = el("button", "daw-fbtn", "Skip tour");
    skip.type = "button"; skip.addEventListener("click", () => dawTour.skip());
    const next = el("button", "daw-fbtn primary", state.index === state.total - 1 ? "Finish" : "Next");
    next.type = "button"; next.addEventListener("click", () => dawTour.next());
    actions.append(back, pause, skip, next);
    card.append(eyebrow, title, copy, actions);
    layer.append(focus, card);
    layer.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault(); e.stopPropagation(); dawTour.pause(); return;
      }
      if (e.key !== "Tab") return;
      const focusables = [...card.querySelectorAll("button:not(:disabled)")];
      if (!focusables.length) return;
      const i = focusables.indexOf(document.activeElement);
      if (e.shiftKey && i <= 0) { e.preventDefault(); focusables[focusables.length - 1].focus(); }
      else if (!e.shiftKey && i === focusables.length - 1) { e.preventDefault(); focusables[0].focus(); }
    });
    root.appendChild(layer);

    const position = () => {
      if (!state.target?.isConnected) { dawTour.refresh(); return; }
      const r = state.target.getBoundingClientRect();
      const pad = 7;
      Object.assign(focus.style, {
        left: `${Math.max(4, r.left - pad)}px`,
        top: `${Math.max(4, r.top - pad)}px`,
        width: `${Math.max(24, Math.min(innerWidth - 8, r.width + pad * 2))}px`,
        height: `${Math.max(24, Math.min(innerHeight - 8, r.height + pad * 2))}px`,
      });
      const cardW = Math.min(360, innerWidth - 24);
      const below = r.bottom + 16;
      const top = below + 220 < innerHeight ? below : Math.max(12, r.top - 232);
      const left = Math.max(12, Math.min(innerWidth - cardW - 12, r.left));
      Object.assign(card.style, { width: `${cardW}px`, left: `${left}px`, top: `${top}px` });
    };
    requestAnimationFrame(() => { position(); next.focus(); });
    if (tourScrollHandler) {
      window.removeEventListener("resize", tourScrollHandler);
      window.removeEventListener("scroll", tourScrollHandler, true);
    }
    tourScrollHandler = position;
    window.addEventListener("resize", position, { passive: true });
    window.addEventListener("scroll", position, { capture: true, passive: true });
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
      fbtn("Recover previous save…", showRecoveryPicker),
      fbtn("New song", newSong),
    );
    file.append(fileSum, fileBody);

    const kbToggle = iconBtn("daw-tbtn daw-panel-toggle", "🎹", "Show / hide the keyboard");
    kbToggle.addEventListener("click", () => toggleBottomPanel("keys"));
    const chToggle = iconBtn("daw-tbtn daw-panel-toggle", "🎛", "Show / hide the device chain");
    chToggle.addEventListener("click", () => toggleBottomPanel("chain"));
    const markerBtn = iconBtn("daw-tbtn", "⚑", "Add marker at playhead (M)");
    markerBtn.id = "daw-add-marker";
    markerBtn.addEventListener("click", () => addMarkerAt(engine.beatNow()));
    const guideBtn = iconBtn("daw-tbtn", "◎", "Start the studio tour");
    guideBtn.id = "daw-tour";
    guideBtn.addEventListener("click", () => startDawTour(true));
    const shortcutsBtn = iconBtn("daw-tbtn", "?", "Keyboard shortcuts (?)");
    shortcutsBtn.id = "daw-shortcuts";
    shortcutsBtn.addEventListener("click", showShortcutOverlay);

    const timingGroup = el("div", "daw-transport-group daw-transport-meta");
    timingGroup.append(time, pos, bpmWrap, sig);
    const playbackGroup = el("div", "daw-transport-group");
    playbackGroup.append(toStart, playBtn, recBtn, loopBtn, metroBtn, countInBtn);
    const editGroup = el("div", "daw-transport-group");
    editGroup.append(tools, zoomOut, zoomIn);
    const utilityGroup = el("div", "daw-transport-group daw-transport-utility");
    utilityGroup.append(undoBtn, redoBtn, markerBtn, file, kbToggle, chToggle, guideBtn, shortcutsBtn);
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
    tl.addEventListener("scroll", () => {
      headsScroll.scrollTop = tl.scrollTop;
      scheduleTimelineRefresh();
    });
    body.append(heads, tl);

    // --- bottom area: resize gutter + tab strip + one active panel ---
    const editor = el("div", "daw-panel daw-editor"); editor.id = "daw-editor";
    const keys = el("div", "daw-panel daw-keys"); keys.id = "daw-keys";
    const chain = el("div", "daw-panel daw-chain"); chain.id = "daw-chain";
    const mixer = el("div", "daw-panel daw-mixer"); mixer.id = "daw-mixer";
    const bottomWrap = el("div", "daw-bottom");
    const gutter = el("div", "daw-bottom-gutter");
    gutter.setAttribute("role", "separator");
    gutter.setAttribute("aria-orientation", "horizontal");
    gutter.setAttribute("aria-label", "Resize the bottom panel — drag, arrow keys, Enter collapses");
    gutter.tabIndex = 0;
    const tabs = el("div", "daw-bottom-tabs");
    tabs.setAttribute("role", "tablist");
    tabs.setAttribute("aria-label", "Studio bottom panel");
    for (const [id, label] of [["editor", "EDITOR"], ["keys", "KEYS"], ["chain", "DEVICES"], ["mixer", "MIXER"]]) {
      const b = el("button", "daw-tab", label);
      b.type = "button";
      b.dataset.panel = id;
      b.setAttribute("role", "tab");
      b.addEventListener("click", () => toggleBottomPanel(id));
      tabs.appendChild(b);
    }
    bottomWrap.append(gutter, tabs, editor, keys, chain, mixer);

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
    const saveRead = el("span", "daw-status-save", "Saved");
    saveRead.id = "daw-save-read";
    status.append(snapLabel, zoomRead, followBtn, selectionRead, quantizeBtn, duplicateBtn, deleteBtn, saveRead, audioRead);

    shell.append(tp, body, bottomWrap, status);
    root.appendChild(shell);
    el_ = {
      shell, tp, time, pos, playBtn, recBtn, ruler, lanes, playhead, tl, headsScroll,
      editor, keys, chain, mixer, tabs, gutter, kbToggle, chToggle, status, snapSel,
      zoomRead, followBtn, selectionRead, duplicateBtn, deleteBtn, audioRead, saveRead,
    };

    attachRulerInteractions(ruler);
    attachLaneInteractions(lanes);
    attachTimelineDrop(tl);
    attachTimelineNav(tl);
    attachBottomResize(gutter);
    buildKeyboardPanel();
    applyPanels();
    buildShortcutOverlay();
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
      if (["keys", "chain", "mixer"].includes(s.prev)) bottom.prev = s.prev;
      // Never restore "editor" across loads — its region no longer exists.
      if ([null, "keys", "chain", "mixer"].includes(s.active)) bottom.active = s.active;
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
      _toast("Double-click a region to edit it");
      return;
    }
    if (bottom.active === id) {
      bottom.reopen = id;
      bottom.active = null;
    } else {
      bottom.active = id;
      if (id !== "editor") bottom.prev = id;
      if (id === "mixer") bottom.h = Math.max(bottom.h, 300);
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
    el_.mixer.hidden = bottom.active !== "mixer";
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
    if (bottom.active === "mixer") renderMixer();
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

  /** Zoom keeping `anchorBeat` fixed at viewport x `anchorX` (px). */
  function setZoomAnchored(v, anchorBeat, anchorX) {
    const tl = el_.tl;
    pxPerBeat = Math.max(6, Math.min(160, v));
    if (song?.view) song.view.zoom = pxPerBeat;
    renderTimeline();
    if (tl) tl.scrollLeft = Math.max(0, anchorBeat * pxPerBeat - anchorX);
    syncStatus();
    save();
  }
  function setZoom(v) {
    const tl = el_.tl;
    const cx = tl ? tl.clientWidth / 2 : 0;
    const centreBeat = tl ? (tl.scrollLeft + cx) / pxPerBeat : 0;
    setZoomAnchored(v, centreBeat, cx);
  }

  function syncStatus() {
    if (!el_.status) return;
    el_.zoomRead.textContent = `ZOOM ${Math.round((pxPerBeat / 26) * 100)}%`;
    el_.snapSel.value = String(snapStep);
    el_.followBtn.classList.toggle("active", followPlayhead);
    el_.followBtn.setAttribute("aria-pressed", followPlayhead ? "true" : "false");
    const items = selectedRegions();
    el_.selectionRead.textContent = items.length > 1
      ? `${items.length} regions selected`
      : items.length === 1
        ? `${items[0].track.name} · ${items[0].region.name} · ${items[0].region.len.toFixed(2)} beats`
        : "No region selected";
    el_.duplicateBtn.disabled = !items.length;
    el_.deleteBtn.disabled = !items.length;
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
    if (bottom.active === "mixer") renderMixer();
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
      attachHeadStrip(strip, t);
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
        mk("daw-auto-toggle", "A", `Show automation for ${t.name}`, t.automationVisible, () => {
          pushState();
          t.automationVisible = !t.automationVisible;
          if (t.automationVisible && !(t.automation[t.automationParam] || []).length) {
            t.automation[t.automationParam] = [{
              id: idc++,
              b: 0,
              v: staticAutomationValue(t, t.automationParam),
            }];
          }
          renderHeads(); renderTimeline(); save();
        }),
      );
      if (t.automationVisible) {
        const autoSel = el("select", "daw-head-auto-select");
        autoSel.setAttribute("aria-label", `${t.name} automation parameter`);
        for (const [key, spec] of Object.entries(AUTO_SPEC)) {
          const option = el("option", null, spec.label);
          option.value = key;
          option.selected = key === t.automationParam;
          autoSel.appendChild(option);
        }
        autoSel.addEventListener("pointerdown", (e) => e.stopPropagation());
        autoSel.addEventListener("change", (e) => {
          e.stopPropagation();
          pushState();
          t.automationParam = autoSel.value;
          if (!(t.automation[t.automationParam] || []).length) {
            t.automation[t.automationParam] = [{
              id: idc++,
              b: 0,
              v: staticAutomationValue(t, t.automationParam),
            }];
          }
          renderTimeline(); save();
        });
        const addAuto = mk("daw-auto-add", "+", `Add ${AUTO_SPEC[t.automationParam].label} point at playhead`, false, () => {
          addAutomationPoint(t, t.automationParam, engine.beatNow());
        });
        row.append(autoSel, addAuto);
      }
      const takes = (t.regions || []).filter((r) => r.takeGroup != null);
      if (takes.length > 1) {
        const isOpen = song.view.openTakeTrackIds.includes(t.id);
        row.appendChild(mk("daw-takes-toggle", `TAKES ${takes.length}`, `${isOpen ? "Hide" : "Show"} takes for ${t.name}`, isOpen, () => {
          const set = new Set(song.view.openTakeTrackIds);
          if (set.has(t.id)) set.delete(t.id); else set.add(t.id);
          song.view.openTakeTrackIds = [...set];
          renderHeads(); renderTimeline(); save();
        }));
      }
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
        song.view.openTakeTrackIds = song.view.openTakeTrackIds.filter((id) => id !== t.id);
        if (activeTrackId === t.id) activeTrackId = song.tracks[0]?.id ?? null;
        // The editor may hold one of this track's regions while another tab is
        // in front — leaving it set would keep a ghost EDITOR tab alive.
        if (editRegion && (t.regions || []).includes(editRegion)) closeEditor();
        engine.rebuildTrack(t.id);
        renderAll(); save();
        _toast("Track deleted — Ctrl+Z to undo.");
      });
      const dupBtn = iconBtn("daw-hbtn daw-head-dup", "⧉", `Duplicate ${t.name}`);
      dupBtn.addEventListener("click", (e) => { e.stopPropagation(); duplicateTrack(t); });
      const meter = el("div", "daw-head-meter");
      meter.dataset.meterTrack = t.id;
      meter.setAttribute("aria-hidden", "true");
      meter.appendChild(el("i"));
      h.append(strip, name, row, meter, dupBtn, delBtn);
      h.addEventListener("pointerdown", () => setActiveTrack(t.id));
      wrap.appendChild(h);
    }
  }

  /** The colour strip doubles as controls: drag reorders, click recolours. */
  function attachHeadStrip(strip, t) {
    strip.title = "Drag to reorder · click to change colour";
    let sdrag = null;
    strip.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      sdrag = { y: e.clientY, moved: false, from: song.tracks.indexOf(t), to: null };
      try { strip.setPointerCapture(e.pointerId); } catch {}
    });
    strip.addEventListener("pointermove", (e) => {
      if (!sdrag) return;
      if (!sdrag.moved && Math.abs(e.clientY - sdrag.y) < 6) return;
      sdrag.moved = true;
      const rect = el_.headsScroll.getBoundingClientRect();
      const idx = Math.max(0, Math.min(song.tracks.length - 1,
        Math.floor((e.clientY - rect.top + el_.headsScroll.scrollTop) / LANE_H)));
      sdrag.to = idx;
      el_.headsScroll.querySelectorAll(".daw-head").forEach((x, i) => x.classList.toggle("drop-target", i === idx && idx !== sdrag.from));
    });
    const sup = () => {
      if (!sdrag) return;
      const d = sdrag; sdrag = null;
      el_.headsScroll.querySelectorAll(".daw-head").forEach((x) => x.classList.remove("drop-target"));
      if (!d.moved) {
        pushStateGesture("color:" + t.id);
        t.color = (t.color + 1) % TRACK_COLORS.length;
        renderHeads(); renderTimeline(); save();
        return;
      }
      if (d.to == null || d.to === d.from) return;
      pushState();
      song.tracks.splice(d.to, 0, song.tracks.splice(d.from, 1)[0]);
      renderAll(); save();
    };
    strip.addEventListener("pointerup", sup);
    strip.addEventListener("pointercancel", sup);
  }

  function duplicateTrack(t) {
    pushState();
    const copy = structuredClone(t);
    copy.id = idc++;
    copy.name = (t.name + " copy").slice(0, 24);
    copy.armed = false;
    copy.solo = false;
    const takeGroups = new Map();
    for (const r of copy.regions || []) {
      r.id = idc++;
      if (r.takeGroup != null) {
        const old = String(r.takeGroup);
        if (!takeGroups.has(old)) takeGroups.set(old, `take-${copy.id}-${idc++}`);
        r.takeGroup = takeGroups.get(old);
      }
    }
    for (const points of Object.values(copy.automation || {})) {
      for (const point of points || []) point.id = idc++;
    }
    song.tracks.splice(song.tracks.indexOf(t) + 1, 0, copy);
    activeTrackId = copy.id;
    engine.rebuildTrack(copy.id);
    renderAll(); save();
    _toast(`Duplicated ${t.name}`, { severity: "ok" });
  }

  function setActiveTrack(id) {
    if (activeTrackId === id) return;
    activeTrackId = id;
    renderHeads(); renderChain();
    if (bottom.active === "mixer") renderMixer();
  }

  function renderTimeline() {
    const ruler = el_.ruler, lanes = el_.lanes;
    const end = songEnd() + 8 * beatsPerBar();
    const width = end * pxPerBeat;
    ruler.innerHTML = ""; lanes.innerHTML = "";
    ruler.style.width = width + "px";
    lanes.style.width = width + "px";

    const bpb = beatsPerBar();
    const viewportW = el_.tl?.clientWidth || width;
    const overscan = bpb * 2;
    const viewA = Math.max(0, (el_.tl?.scrollLeft || 0) / pxPerBeat - overscan);
    const viewB = Math.min(end, ((el_.tl?.scrollLeft || 0) + viewportW) / pxPerBeat + overscan);
    const firstBar = Math.max(0, Math.floor(viewA / bpb) * bpb);
    for (let b = firstBar; b <= viewB + 1e-7; b += bpb) {
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
    renderMarkers(ruler, viewA, viewB, end);

    for (const t of song.tracks) {
      const lane = el("div", "daw-lane");
      lane.dataset.track = t.id;
      lane.style.setProperty("--tc", TRACK_COLORS[t.color % TRACK_COLORS.length]);
      // bar grid backdrop
      lane.style.backgroundSize = `${bpb * pxPerBeat}px 100%, ${pxPerBeat}px 100%`;
      const takesOpen = song.view.openTakeTrackIds.includes(t.id);
      lane.classList.toggle("takes-open", takesOpen);
      const regionTakeRows = new Map();
      for (const r of t.regions) {
        if (r.start + r.len < viewA || r.start > viewB) continue;
        if (r.takeGroup != null && r.takeActive === false && !takesOpen) continue;
        let takeRow = 0;
        if (r.takeGroup != null) {
          const key = String(r.takeGroup);
          const n = regionTakeRows.get(key) || 0;
          regionTakeRows.set(key, n + 1);
          takeRow = n;
        }
        lane.appendChild(regionEl(t, r, takeRow));
      }
      if (t.automationVisible) lane.appendChild(renderAutomationLayer(t, width, viewA, viewB));
      lanes.appendChild(lane);
    }
    positionPlayhead(engine ? engine.beatNow() : 0);
    syncStatus();
  }

  function scheduleTimelineRefresh() {
    if (timelineRefreshFrame) return;
    timelineRefreshFrame = requestAnimationFrame(() => {
      timelineRefreshFrame = 0;
      renderTimeline();
    });
  }

  function renderMarkers(ruler, viewA, viewB, end) {
    const markers = [...(song.markers || [])].sort((a, b) => a.beat - b.beat);
    let previous = null;
    for (const marker of markers) {
      if (marker.beat <= viewA) previous = marker;
      if (marker.beat > viewB) break;
    }
    const visible = markers.filter((m) => m.beat >= viewA && m.beat <= viewB);
    if (previous && !visible.includes(previous)) visible.unshift(previous);
    for (const marker of visible) {
      const next = markers.find((m) => m.beat > marker.beat);
      const section = el("div", "daw-marker-section");
      section.style.left = marker.beat * pxPerBeat + "px";
      section.style.width = Math.max(12, ((next?.beat ?? end) - marker.beat) * pxPerBeat) + "px";
      section.style.setProperty("--mc", TRACK_COLORS[marker.color % TRACK_COLORS.length]);
      const button = el("button", "daw-marker" + (marker.id === selectedMarkerId ? " selected" : ""), marker.name);
      button.type = "button";
      button.dataset.marker = marker.id;
      button.style.left = marker.beat * pxPerBeat + "px";
      button.style.setProperty("--mc", TRACK_COLORS[marker.color % TRACK_COLORS.length]);
      button.setAttribute("aria-label", `${marker.name}, ${formatMusicalPosition(marker.beat, beatsPerBar(), snapStep)}`);
      attachMarkerInteractions(button, marker);
      ruler.append(section, button);
    }
  }

  function addMarkerAt(beat) {
    const at = snap(Math.max(0, +beat || 0));
    const existing = (song.markers || []).find((m) => Math.abs(m.beat - at) < MIN_SNAP / 2);
    if (existing) {
      selectedMarkerId = existing.id;
      renderTimeline();
      const button = el_.ruler.querySelector(`[data-marker="${existing.id}"]`);
      if (button) beginMarkerRename(existing, button);
      return existing;
    }
    pushState();
    const marker = {
      id: idc++,
      beat: at,
      name: `Section ${(song.markers?.length || 0) + 1}`,
      color: (song.markers?.length || 0) % TRACK_COLORS.length,
    };
    (song.markers ||= []).push(marker);
    song.markers.sort((a, b) => a.beat - b.beat);
    selectedMarkerId = marker.id;
    renderTimeline(); save();
    requestAnimationFrame(() => {
      const button = el_.ruler.querySelector(`[data-marker="${marker.id}"]`);
      if (button) beginMarkerRename(marker, button);
    });
    return marker;
  }

  function attachMarkerInteractions(button, marker) {
    let drag = null;
    button.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      selectedMarkerId = marker.id;
      drag = { x: e.clientX, beat: marker.beat, pushed: false };
      try { button.setPointerCapture(e.pointerId); } catch {}
    });
    button.addEventListener("pointermove", (e) => {
      if (!drag || Math.abs(e.clientX - drag.x) < 3) return;
      if (!drag.pushed) { pushState(); drag.pushed = true; }
      marker.beat = Math.max(0, snap(drag.beat + (e.clientX - drag.x) / pxPerBeat));
      button.style.left = marker.beat * pxPerBeat + "px";
      button.setAttribute("aria-label", `${marker.name}, ${formatMusicalPosition(marker.beat, beatsPerBar(), snapStep)}`);
    });
    const finish = () => {
      if (!drag) return;
      const changed = drag.pushed;
      drag = null;
      if (changed) {
        song.markers.sort((a, b) => a.beat - b.beat);
        renderTimeline(); save();
      } else {
        renderTimeline();
      }
    };
    button.addEventListener("pointerup", finish);
    button.addEventListener("pointercancel", finish);
    button.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      beginMarkerRename(marker, button);
    });
    button.addEventListener("keydown", (e) => {
      if (e.key === "F2" || e.key === "Enter") {
        e.preventDefault(); beginMarkerRename(marker, button);
      } else if (e.key === "Delete" || e.key === "Backspace") {
        e.preventDefault(); e.stopPropagation(); deleteSelectedMarker();
      }
    });
  }

  function beginMarkerRename(marker, button) {
    if (button.querySelector("input")) return;
    const input = el("input", "daw-marker-input");
    input.value = marker.name;
    button.textContent = "";
    button.appendChild(input);
    input.addEventListener("pointerdown", (e) => e.stopPropagation());
    const commit = () => {
      const name = input.value.trim().slice(0, 32);
      if (name && name !== marker.name) {
        pushState();
        marker.name = name;
        save();
      }
      renderTimeline();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); input.blur(); }
      if (e.key === "Escape") { e.preventDefault(); input.value = marker.name; input.blur(); }
    });
    input.addEventListener("blur", commit, { once: true });
    input.focus(); input.select();
  }

  function deleteSelectedMarker() {
    if (selectedMarkerId == null) return false;
    const i = (song.markers || []).findIndex((m) => m.id === selectedMarkerId);
    if (i < 0) { selectedMarkerId = null; return false; }
    pushState();
    song.markers.splice(i, 1);
    selectedMarkerId = null;
    renderTimeline(); save();
    _toast("Marker deleted — Ctrl+Z to undo.");
    return true;
  }

  function regionEl(t, r, takeRow = 0) {
    const isTake = r.takeGroup != null;
    const isInactiveTake = isTake && r.takeActive === false;
    const d = el("div", "daw-region" + (selHas(r.id) ? " sel" : "")
      + (t.kind === "audio" ? " audio" : "")
      + (isTake ? " is-take" : "")
      + (isInactiveTake ? " take-alt" : " take-active"));
    d.dataset.region = r.id;
    d.tabIndex = 0;
    d.setAttribute("role", "group");
    d.setAttribute("aria-label", `${r.name || "Region"} on ${t.name}, ${r.len.toFixed(2)} beats`);
    d.setAttribute("aria-selected", selHas(r.id) ? "true" : "false");
    d.style.left = r.start * pxPerBeat + "px";
    d.style.width = Math.max(6, r.len * pxPerBeat) + "px";
    const label = el("span", "daw-region-name", r.name || "New Region");
    const cv = el("canvas", "daw-region-cv");
    d.append(label, cv, el("div", "daw-region-edge left"), el("div", "daw-region-edge right"));
    if (isTake) {
      d.style.setProperty("--take-row", String(Math.max(0, takeRow - 1) % 2));
      const takeButton = el("button", "daw-take-use", isInactiveTake ? `USE ${r.takeNo || ""}` : `TAKE ${r.takeNo || ""}`);
      takeButton.type = "button";
      takeButton.setAttribute("aria-label", isInactiveTake ? `Use take ${r.takeNo}` : `Active take ${r.takeNo}`);
      takeButton.addEventListener("pointerdown", (e) => e.stopPropagation());
      takeButton.addEventListener("click", (e) => {
        e.stopPropagation();
        activateTake(t, r);
      });
      d.appendChild(takeButton);
    }
    if (t.kind === "audio") {
      const fl = el("div", "daw-fade-handle left");
      fl.title = "Fade in — drag";
      const fr = el("div", "daw-fade-handle right");
      fr.title = "Fade out — drag";
      d.append(fl, fr);
    }
    requestAnimationFrame(() => drawRegionPreview(cv, t, r));
    return d;
  }

  function activateTake(track, region) {
    if (region.takeGroup == null || region.takeActive !== false) return;
    pushState();
    for (const r of track.regions || []) {
      if (String(r.takeGroup) === String(region.takeGroup)) r.takeActive = r.takeNo === region.takeNo;
    }
    sel = [{ trackId: track.id, regionId: region.id }];
    engine?.syncGraph?.();
    renderTimeline(); save();
    _toast(`Using take ${region.takeNo}`, { severity: "ok" });
  }

  function staticAutomationValue(track, key) {
    if (key === "gain") return track.gain;
    if (key === "pan") return track.pan;
    return track.sends?.[key] ?? 0;
  }

  function automationAt(points, beat, fallback) {
    if (!points?.length) return fallback;
    if (beat <= points[0].b) return points[0].v;
    const last = points[points.length - 1];
    if (beat >= last.b) return last.v;
    for (let i = 1; i < points.length; i++) {
      const right = points[i];
      if (beat > right.b) continue;
      const left = points[i - 1];
      const f = (beat - left.b) / Math.max(Number.EPSILON, right.b - left.b);
      return left.v + (right.v - left.v) * f;
    }
    return fallback;
  }

  function addAutomationPoint(track, key, beat, value = null) {
    const spec = AUTO_SPEC[key];
    if (!spec) return;
    const at = snap(Math.max(0, +beat || 0));
    const points = track.automation[key] ||= [];
    const val = clampFinite(
      value == null ? automationAt(points, at, staticAutomationValue(track, key)) : value,
      spec.min,
      spec.max,
      staticAutomationValue(track, key),
    );
    pushState();
    const existing = points.find((p) => Math.abs(p.b - at) < 1e-7);
    if (existing) existing.v = val;
    else points.push({ id: idc++, b: at, v: val });
    points.sort((a, b) => a.b - b.b);
    track.automationVisible = true;
    track.automationParam = key;
    engine?.refreshMixParams?.();
    renderHeads(); renderTimeline(); save();
  }

  function renderAutomationLayer(track, width, viewA, viewB) {
    const key = track.automationParam;
    const spec = AUTO_SPEC[key];
    const points = track.automation[key] ||= [];
    const NS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(NS, "svg");
    svg.classList.add("daw-automation");
    svg.dataset.track = track.id;
    svg.dataset.param = key;
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(LANE_H));
    svg.setAttribute("viewBox", `0 0 ${width} ${LANE_H}`);
    svg.setAttribute("role", "group");
    svg.setAttribute("aria-label", `${track.name} ${spec.label} automation`);
    const yFor = (value) => 8 + (1 - (value - spec.min) / (spec.max - spec.min)) * (LANE_H - 16);
    const path = document.createElementNS(NS, "path");
    path.classList.add("daw-automation-path");
    const paintPath = () => {
      const pts = points.length ? points : [
        { b: 0, v: staticAutomationValue(track, key) },
        { b: songEnd() + 8 * beatsPerBar(), v: staticAutomationValue(track, key) },
      ];
      path.setAttribute("d", pts.map((p, i) => `${i ? "L" : "M"} ${p.b * pxPerBeat} ${yFor(p.v)}`).join(" "));
    };
    paintPath();
    svg.appendChild(path);
    for (const point of points) {
      if (point.b < viewA - beatsPerBar() || point.b > viewB + beatsPerBar()) continue;
      const circle = document.createElementNS(NS, "circle");
      circle.classList.add("daw-automation-point");
      circle.setAttribute("cx", String(point.b * pxPerBeat));
      circle.setAttribute("cy", String(yFor(point.v)));
      circle.setAttribute("r", "5");
      circle.setAttribute("tabindex", "0");
      circle.setAttribute("role", "button");
      const updateLabel = () => circle.setAttribute("aria-label",
        `${spec.label} ${point.v.toFixed(2)} at ${formatMusicalPosition(point.b, beatsPerBar(), snapStep)}`);
      updateLabel();
      let drag = null;
      circle.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); e.preventDefault();
        drag = { x: e.clientX, y: e.clientY, b: point.b, v: point.v, pushed: false };
        try { circle.setPointerCapture(e.pointerId); } catch {}
      });
      circle.addEventListener("pointermove", (e) => {
        if (!drag) return;
        if (!drag.pushed && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 3) return;
        if (!drag.pushed) { pushState(); drag.pushed = true; }
        point.b = Math.max(0, snap(drag.b + (e.clientX - drag.x) / pxPerBeat));
        point.v = clampFinite(drag.v - (e.clientY - drag.y) / (LANE_H - 16) * (spec.max - spec.min), spec.min, spec.max, drag.v);
        circle.setAttribute("cx", String(point.b * pxPerBeat));
        circle.setAttribute("cy", String(yFor(point.v)));
        updateLabel(); paintPath();
        engine?.refreshMixParams?.();
      });
      const finish = () => {
        if (!drag) return;
        const changed = drag.pushed;
        drag = null;
        if (changed) {
          points.sort((a, b) => a.b - b.b);
          renderTimeline(); save();
        }
      };
      circle.addEventListener("pointerup", finish);
      circle.addEventListener("pointercancel", finish);
      circle.addEventListener("keydown", (e) => {
        if (e.key === "Delete" || e.key === "Backspace") {
          e.preventDefault(); e.stopPropagation(); pushState();
          points.splice(points.indexOf(point), 1);
        } else if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(e.key)) {
          e.preventDefault(); e.stopPropagation(); pushStateGesture(`automation:${track.id}:${point.id}`);
          if (e.key === "ArrowLeft") point.b = Math.max(0, point.b - gridStep());
          if (e.key === "ArrowRight") point.b += gridStep();
          const dv = (spec.max - spec.min) / (e.shiftKey ? 10 : 50);
          if (e.key === "ArrowUp") point.v = Math.min(spec.max, point.v + dv);
          if (e.key === "ArrowDown") point.v = Math.max(spec.min, point.v - dv);
        } else return;
        points.sort((a, b) => a.b - b.b);
        engine?.refreshMixParams?.();
        renderTimeline(); save();
      });
      svg.appendChild(circle);
    }
    svg.addEventListener("dblclick", (e) => {
      if (e.target !== svg && e.target !== path) return;
      e.stopPropagation();
      const rect = svg.getBoundingClientRect();
      const beat = (e.clientX - rect.left) / pxPerBeat;
      const ratio = Math.max(0, Math.min(1, (e.clientY - rect.top - 8) / (LANE_H - 16)));
      addAutomationPoint(track, key, beat, spec.max - ratio * (spec.max - spec.min));
    });
    return svg;
  }

  function drawRegionPreview(cv, t, r) {
    // CSS can stretch the preview across a very long region; keeping the
    // backing bitmap bounded avoids browser canvas limits on large projects.
    const w = Math.min(2048, Math.max(2, Math.round(r.len * pxPerBeat))), h = PREVIEW_H;
    cv.width = w * (devicePixelRatio || 1); cv.height = h * (devicePixelRatio || 1);
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(devicePixelRatio || 1, devicePixelRatio || 1);
    g.clearRect(0, 0, w, h);
    const lane = cv.closest(".daw-lane");
    if (!lane || !cv.isConnected) return;
    const ink = getComputedStyle(lane).getPropertyValue("--tc") || "#8fd";
    g.fillStyle = ink; g.strokeStyle = ink; g.globalAlpha = 0.9;
    const px = (b) => (b / r.len) * w;
    if (t.kind === "audio") {
      const clip = clips.get(r.clipId);
      if (!clip) { g.globalAlpha = 0.4; g.fillRect(0, h / 2 - 1, w, 2); return; }
      const data = clip.getChannelData(0);
      const start = Math.floor((r.offset || 0) * clip.sampleRate);
      const sourceSpb = r.tempoMode === "repitch" ? 60 / (r.sourceBpm || song.bpm) : 60 / song.bpm;
      const span = Math.min(data.length - start, Math.floor(r.len * sourceSpb * clip.sampleRate));
      const step = Math.max(1, Math.floor(span / w));
      const rGain = Math.max(0.05, Math.min(2, r.gain ?? 1));
      g.beginPath();
      for (let x = 0; x < w; x++) {
        let peak = 0;
        const s0 = start + x * step;
        for (let i = 0; i < step && s0 + i < data.length; i += 4) peak = Math.max(peak, Math.abs(data[s0 + i]));
        const y = Math.min(1, peak * rGain) * (h / 2 - 2);
        g.moveTo(x, h / 2 - y); g.lineTo(x, h / 2 + y + 0.5);
      }
      g.stroke();
      // Fade ramps: diagonal from silence to full at each faded end.
      const fi = px(Math.max(0, Math.min(r.len, r.fadeIn || 0)));
      const fo = px(Math.max(0, Math.min(r.len, r.fadeOut || 0)));
      if (fi > 1 || fo > 1) {
        g.globalAlpha = 1;
        g.lineWidth = 1.4;
        g.beginPath();
        if (fi > 1) { g.moveTo(0, h - 1); g.lineTo(fi, 1); }
        if (fo > 1) { g.moveTo(w, h - 1); g.lineTo(w - fo, 1); }
        g.stroke();
        g.lineWidth = 1;
      }
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
      if (e.button !== 0) return;
      if (engine.recording) {
        _toast("Stop recording before moving the playhead or loop.", { severity: "error" });
        e.preventDefault();
        return;
      }
      const b = beatAt(e);
      // Near an existing loop edge? Drag adjusts that edge instead of
      // redrawing the whole range.
      let mode = "range";
      if (song.loop.on) {
        if (Math.abs(b - song.loop.a) * pxPerBeat < 7) mode = "edge-a";
        else if (Math.abs(b - song.loop.b) * pxPerBeat < 7) mode = "edge-b";
      }
      drag = { start: b, moved: false, mode };
      try { ruler.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    ruler.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const b = beatAt(e);
      const threshold = drag.mode === "range" ? 5 : 3;
      if (!drag.moved && Math.abs(b - drag.start) * pxPerBeat < threshold) return;
      if (!drag.moved) {
        drag.moved = true;
        pushState();
        if (drag.mode === "range") song.loop.on = true;
      }
      if (drag.mode === "edge-a") {
        song.loop.a = Math.max(0, Math.min(snap(b), song.loop.b - minLen()));
      } else if (drag.mode === "edge-b") {
        song.loop.b = Math.max(song.loop.a + minLen(), snap(b));
      } else {
        song.loop.a = snap(Math.min(drag.start, b));
        song.loop.b = Math.max(song.loop.a + minLen(), snap(Math.max(drag.start, b)));
      }
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
    ruler.addEventListener("dblclick", (e) => {
      if (e.target.closest?.(".daw-marker")) return;
      e.preventDefault();
      addMarkerAt(beatAt(e));
    });
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
      const fade = e.target.classList.contains("daw-fade-handle") ? (e.target.classList.contains("left") ? "left" : "right") : null;
      return { lane, track, beat, region, regionEl: regionEl_, edge, fade };
    };
    const laneIndexAt = (e) => {
      const rect = lanes.getBoundingClientRect();
      return Math.max(0, Math.min(song.tracks.length - 1, Math.floor((e.clientY - rect.top) / LANE_H)));
    };

    lanes.addEventListener("pointerdown", (e) => {
      if (e.button !== 0) return;
      const h = hitAt(e);
      if (!h) return;
      if (e.target.closest?.(".daw-automation")) return;
      selectedMarkerId = null;
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
      if (tool === "draw") {
        if (h.track.kind === "audio") { _toast("Draw works on synth and drum tracks — record or import audio instead"); return; }
        pushState();
        const start = snap(h.beat);
        const r = makeRegion(h.track, start, minLen());
        drag = { mode: "draw", track: h.track, region: r, anchor: start };
        sel = [{ trackId: h.track.id, regionId: r.id }];
        h.lane.appendChild(regionEl(h.track, r));
        syncSelClasses();
        return;
      }
      // ---- select tool ----
      // Undo snapshots are deferred to the first REAL change: a plain
      // selection click must not wipe the redo stack.
      if (h.fade && h.region && h.track.kind === "audio") {
        drag = { mode: "fade", which: h.fade, track: h.track, region: h.region, moved: false };
        return;
      }
      if (h.region) {
        if (e.shiftKey) {
          // Shift-click toggles membership and never starts a drag.
          sel = selHas(h.region.id)
            ? sel.filter((s) => s.regionId !== h.region.id)
            : [...sel, { trackId: h.track.id, regionId: h.region.id }];
          syncSelClasses();
          return;
        }
        // Click inside the current selection keeps the group (promoting the
        // clicked region to primary); outside replaces it.
        sel = selHas(h.region.id)
          ? [{ trackId: h.track.id, regionId: h.region.id }, ...sel.filter((s) => s.regionId !== h.region.id)]
          : [{ trackId: h.track.id, regionId: h.region.id }];
        syncSelClasses();

        if (h.edge) {
          drag = {
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
          };
          return;
        }
        let items = selectedRegions().map(({ track, region }) => ({ track, region, orig: region.start }));
        let moved = false;
        if (e.altKey) {
          // Alt-drag: duplicate the selection in place and drag the copies.
          pushState();
          const copies = [];
          for (const it of items) {
            const copy = duplicateRegion(it.region, idc++, it.region.start);
            copy.name = it.region.name;
            it.track.regions.push(copy);
            const laneEl = lanes.querySelector(`.daw-lane[data-track="${it.track.id}"]`);
            laneEl?.appendChild(regionEl(it.track, copy));
            copies.push({ track: it.track, region: copy, orig: copy.start });
          }
          sel = copies.map((c) => ({ trackId: c.track.id, regionId: c.region.id }));
          items = copies;
          moved = true;                    // snapshot already taken
          syncSelClasses();
        }
        const primary = items.find((it) => it.region.id === sel[0].regionId) || items[0];
        drag = { mode: "move", items, primary, grab: h.beat - primary.region.start, moved };
        return;
      }
      // ---- empty space → marquee ----
      const base = e.shiftKey ? [...sel] : [];
      sel = base;
      syncSelClasses();
      const rect = lanes.getBoundingClientRect();
      const mEl = el("div", "daw-marquee");
      lanes.appendChild(mEl);
      drag = { mode: "marquee", x0: e.clientX - rect.left, y0: e.clientY - rect.top, el: mEl, base };
    });

    lanes.addEventListener("pointermove", (e) => {
      if (!drag) return;
      const lanesRect = lanes.getBoundingClientRect();
      const beat = Math.max(0, (e.clientX - lanesRect.left) / pxPerBeat);
      const r = drag.region;
      if (drag.mode === "draw") {
        const b = snap(beat);
        if (b < drag.anchor) {
          r.start = b;
          r.len = drag.anchor - b;
        } else {
          r.start = drag.anchor;
          r.len = Math.max(minLen(), b - drag.anchor);
        }
        redrawRegion(drag.track, r);
      } else if (drag.mode === "fade") {
        if (!drag.moved) { pushState(); drag.moved = true; }
        const fr = drag.region;
        const local = Math.max(0, Math.min(fr.len, beat - fr.start));
        if (drag.which === "left") fr.fadeIn = clampedFade(fr.len, fr.fadeOut || 0, snap(local));
        else fr.fadeOut = clampedFade(fr.len, fr.fadeIn || 0, snap(fr.len - local));
        redrawRegion(drag.track, fr);
      } else if (drag.mode === "move") {
        // One horizontal delta for the whole group, snapped relative to the
        // primary region so grid alignment of every member is preserved.
        const rawDelta = beat - drag.grab - drag.primary.orig;
        let db = snapStep > 0 ? Math.round(rawDelta / snapStep) * snapStep : rawDelta;
        db = Math.max(db, -Math.min(...drag.items.map((it) => it.orig)));
        const changed = drag.items.some((it) => it.orig + db !== it.region.start);
        // Vertical: single-region drags may cross onto a same-kind track.
        let targetTrack = null;
        if (drag.items.length === 1) {
          const t2 = song.tracks[laneIndexAt(e)];
          if (t2 && t2 !== drag.items[0].track && t2.kind === drag.items[0].track.kind) targetTrack = t2;
        }
        if (!changed && !targetTrack) return;
        if (!drag.moved) { pushState(); drag.moved = true; }
        for (const it of drag.items) {
          it.region.start = it.orig + db;
          redrawRegion(it.track, it.region);
        }
        if (targetTrack) {
          const it = drag.items[0];
          it.track.regions = it.track.regions.filter((x) => x !== it.region);
          targetTrack.regions.push(it.region);
          const elNode = lanes.querySelector(`.daw-region[data-region="${it.region.id}"]`);
          const laneEl = lanes.querySelector(`.daw-lane[data-track="${targetTrack.id}"]`);
          if (elNode && laneEl) laneEl.appendChild(elNode);
          it.track = targetTrack;
          if (editRegion === it.region) drag.editorMoved = true;
          sel = [{ trackId: targetTrack.id, regionId: it.region.id }];
          setActiveTrack(targetTrack.id);
        }
      } else if (drag.mode === "resize") {
        if (!drag.moved) pushState();       // capture the pre-resize state once
        drag.moved = true;
        if (drag.edge === "right") {
          r.len = Math.max(minLen(), snap(beat) - r.start);
          if (drag.track.kind === "audio") {
            r.fadeIn = clampedFade(r.len, 0, r.fadeIn || 0);
            r.fadeOut = clampedFade(r.len, r.fadeIn || 0, r.fadeOut || 0);
          }
        } else {
          const ns = Math.min(snap(beat), drag.orig.start + drag.orig.len - minLen());
          const delta = ns - drag.orig.start;
          r.start = Math.max(0, ns);
          r.len = drag.orig.len - delta;
          Object.assign(r, trimRegionStartContent(
            drag.track.kind,
            drag.orig.region,
            delta,
            drag.orig.region.tempoMode === "repitch"
              ? 60 / (drag.orig.region.sourceBpm || song.bpm)
              : 60 / song.bpm,
          ));
          if (drag.track.kind === "audio") {
            r.fadeIn = clampedFade(r.len, 0, r.fadeIn || 0);
            r.fadeOut = clampedFade(r.len, r.fadeIn, r.fadeOut || 0);
          }
        }
        redrawRegion(drag.track, r);
      } else if (drag.mode === "marquee") {
        const x1 = e.clientX - lanesRect.left, y1 = e.clientY - lanesRect.top;
        const bx = Math.min(drag.x0, x1), by = Math.min(drag.y0, y1);
        drag.el.style.left = bx + "px";
        drag.el.style.top = by + "px";
        drag.el.style.width = Math.abs(x1 - drag.x0) + "px";
        drag.el.style.height = Math.abs(y1 - drag.y0) + "px";
        const b0 = bx / pxPerBeat, b1 = (bx + Math.abs(x1 - drag.x0)) / pxPerBeat;
        const r0 = Math.floor(by / LANE_H), r1 = Math.floor((by + Math.abs(y1 - drag.y0)) / LANE_H);
        const picked = [];
        song.tracks.forEach((t, i) => {
          if (i < r0 || i > r1) return;
          for (const reg of t.regions || []) {
            if (reg.start < b1 && reg.start + reg.len > b0) picked.push({ trackId: t.id, regionId: reg.id });
          }
        });
        sel = [...drag.base.filter((b) => !picked.some((p) => p.regionId === b.regionId)), ...picked];
        syncSelClasses();
      }
    });

    const finish = () => {
      if (!drag) return;
      const d = drag; drag = null;
      if (d.mode === "marquee") { d.el.remove(); syncStatus(); return; }
      if (d.mode === "fade") { if (d.moved) save(); return; }
      if ((d.mode === "move" || d.mode === "resize") && !d.moved) { syncStatus(); return; }
      if (d.mode === "draw" && d.region.len <= minLen() + 1e-6) {
        // A click (not a drag) draws one bar.
        d.region.len = beatsPerBar();
      }
      renderTimeline(); save();
      if (editorOpen() && (
        d.editorMoved ||
        (d.mode === "resize" && d.region === editRegion)
      )) renderEditor();
      if (d.mode === "draw") openEditor(d.track, d.region);
    };
    lanes.addEventListener("pointerup", finish);
    lanes.addEventListener("pointercancel", finish);

    lanes.addEventListener("dblclick", (e) => {
      const h = hitAt(e);
      if (!h) return;
      if (h.region) {
        openEditor(h.track, h.region);
        return;
      }
      if (e.target.closest?.(".daw-automation")) return;
      if (h.track.kind === "audio") {
        importAudioFile(h.track, snap(h.beat));
        return;
      }
      pushState();
      const r = makeRegion(h.track, snap(h.beat), beatsPerBar(), {
        name: h.track.kind === "drums" ? "Drum Pattern" : "MIDI Region",
      });
      sel = [{ trackId: h.track.id, regionId: r.id }];
      renderTimeline(); save();
      openEditor(h.track, r);
    });
  }

  /** Ctrl+wheel = zoom at cursor; middle-drag = pan. */
  function attachTimelineNav(tl) {
    tl.addEventListener("wheel", (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const rect = tl.getBoundingClientRect();
      const viewX = e.clientX - rect.left;
      const anchorBeat = (tl.scrollLeft + viewX) / pxPerBeat;
      const factor = e.deltaY < 0 ? 1.13 : 1 / 1.13;
      setZoomAnchored(pxPerBeat * factor, anchorBeat, viewX);
    }, { passive: false });
    let pan = null;
    tl.addEventListener("pointerdown", (e) => {
      if (e.button !== 1) return;
      e.preventDefault();
      pan = { x: e.clientX, y: e.clientY, sl: tl.scrollLeft, st: tl.scrollTop };
      try { tl.setPointerCapture(e.pointerId); } catch {}
    });
    tl.addEventListener("pointermove", (e) => {
      if (!pan) return;
      tl.scrollLeft = pan.sl - (e.clientX - pan.x);
      tl.scrollTop = pan.st - (e.clientY - pan.y);
    });
    const endPan = () => { pan = null; };
    tl.addEventListener("pointerup", endPan);
    tl.addEventListener("pointercancel", endPan);
    tl.addEventListener("auxclick", (e) => { if (e.button === 1) e.preventDefault(); });
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
    if (atBeat <= r.start + minLen() / 2 || atBeat >= r.start + r.len - minLen() / 2) return;
    pushState();
    const cut = atBeat - r.start;
    const sourceSpb = r.tempoMode === "repitch" ? 60 / (r.sourceBpm || song.bpm) : 60 / song.bpm;
    const content = splitRegionContent(track.kind, r, cut, sourceSpb);
    const right = makeRegion(track, atBeat, content.right.len, { name: r.name });
    Object.assign(r, content.left);
    Object.assign(right, content.right);
    sel = [{ trackId: track.id, regionId: right.id }];
    renderTimeline();
    if (editorOpen() && editRegion === r) renderEditor();
    save();
  }

  function duplicateSelected() {
    const items = selectedRegions();
    if (!items.length) return;
    pushState();
    // The whole selection copies to just after its own end, layout preserved.
    const selEnd = Math.max(...items.map((it) => it.region.start + it.region.len));
    const anchor = Math.min(...items.map((it) => it.region.start));
    const offset = snap(selEnd, "ceil") - anchor;
    const next = [];
    for (const it of items) {
      const copy = duplicateRegion(it.region, idc++, it.region.start + offset);
      copy.name = it.region.name;
      it.track.regions.push(copy);
      next.push({ trackId: it.track.id, regionId: copy.id });
    }
    sel = next;
    renderTimeline();
    save();
    _toast(items.length > 1 ? `${items.length} regions duplicated` : "Region duplicated", { severity: "ok" });
  }

  function nudgeSelected(delta) {
    const items = selectedRegions();
    if (!items.length) return;
    // Alt+Arrow auto-repeats — a held key is one gesture, not one per repeat.
    pushStateGesture("nudge:" + items.map((it) => it.region.id).join(","));
    const db = Math.max(delta, -Math.min(...items.map((it) => it.region.start)));
    // The delta is already grid-sized; applying it directly preserves the
    // relative spacing of off-grid recordings within a multi-region group.
    for (const it of items) it.region.start = Math.max(0, it.region.start + db);
    renderTimeline();
    save();
  }

  function deleteSelected() {
    const items = selectedRegions();
    if (!items.length) return;
    pushState();
    for (const it of items) {
      it.track.regions = it.track.regions.filter((x) => x !== it.region);
      if (editRegion === it.region) closeEditor();
    }
    sel = [];
    renderTimeline(); save();
    _toast(items.length > 1 ? `${items.length} regions deleted — Ctrl+Z to undo.` : "Region deleted — Ctrl+Z to undo.");
  }

  /** Regions the note-level tools operate on: selection, else the open editor. */
  function noteTargets() {
    const items = selectedRegions();
    if (items.length) return items;
    if (editRegion) {
      const track = song.tracks.find((t) => (t.regions || []).includes(editRegion));
      if (track) return [{ track, region: editRegion }];
    }
    return [];
  }

  function quantizeSelected() {
    if (snapStep <= 0) { _toast("Turn snap on to quantize"); return; }
    const items = noteTargets();
    if (!items.length) { _toast("Select a region to quantize"); return; }
    pushState();
    for (const it of items) Object.assign(it.region, quantizeRegionNotes(it.track.kind, it.region, snapStep));
    rollSel = new Set();
    renderTimeline();
    if (editorOpen()) renderEditor();
    save();
    _toast(`Quantized notes to ${snapStep} beat grid`, { severity: "ok" });
  }

  function transposeSelected(semitones) {
    if (rollCtx?.r === editRegion && !rollCtx.isDrums && rollSel.size) {
      const arr = rollNotesArr();
      const targets = arr.filter((n) => rollSel.has(n));
      if (targets.length) {
        pushState();
        const selected = new Set(targets);
        const out = shiftSelectedNotes(arr, (n) => selected.has(n), 0, semitones, editRegion.len);
        replaceRollNotes(arr, out, targets);
        renderRollNotes();
        paintVelLane();
        redrawRegion(rollCtx.track, editRegion);
        save();
        _toast(`Transposed ${semitones > 0 ? "+" + semitones : semitones} semitones`);
        return;
      }
    }
    const items = noteTargets().filter((it) => Array.isArray(it.region.notes));
    if (!items.length) return;
    pushState();
    for (const it of items) Object.assign(it.region, transposeRegionNotes(it.region, semitones));
    rollSel = new Set();
    renderTimeline();
    if (editorOpen()) renderEditor();
    save();
    _toast(`Transposed ${semitones > 0 ? "+" + semitones : semitones} semitones`);
  }

  function nudgeRegionNotes(deltaBeats) {
    if (rollCtx?.r === editRegion && rollSel.size) {
      const arr = rollNotesArr();
      const targets = arr.filter((n) => rollSel.has(n));
      if (targets.length) {
        pushState();
        const selected = new Set(targets);
        const out = shiftSelectedNotes(arr, (n) => selected.has(n), deltaBeats, 0, editRegion.len);
        replaceRollNotes(arr, out, targets);
        renderRollNotes();
        paintVelLane();
        redrawRegion(rollCtx.track, editRegion);
        save();
        _toast(`Shifted notes by ${deltaBeats > 0 ? "+" + deltaBeats : deltaBeats} beats`);
        return;
      }
    }
    const items = noteTargets();
    if (!items.length) return;
    pushState();
    for (const { region: r } of items) {
      if (Array.isArray(r.notes)) r.notes = shiftSelectedNotes(r.notes, () => true, deltaBeats, 0, r.len);
      if (Array.isArray(r.hits)) r.hits = shiftSelectedNotes(r.hits, () => true, deltaBeats, 0, r.len);
    }
    rollSel = new Set();
    renderTimeline();
    if (editorOpen()) renderEditor();
    save();
    _toast(`Shifted notes by ${deltaBeats > 0 ? "+" + deltaBeats : deltaBeats} beats`);
  }

  /* ---------------- region clipboard ---------------- */
  function copySelected() {
    const items = selectedRegions();
    if (!items.length) { _toast("Select regions to copy"); return false; }
    clipboard = buildRegionClipboard(items.map((it) => ({ trackId: it.track.id, kind: it.track.kind, region: it.region })));
    _toast(items.length > 1 ? `${items.length} regions copied` : "Region copied", { severity: "ok" });
    return true;
  }

  function cutSelected() {
    if (copySelected()) deleteSelected();
  }

  function pasteClipboard() {
    if (!clipboard) { _toast("Clipboard is empty — Ctrl+C copies the selection"); return; }
    const at = snap(engine.beatNow());
    const placed = materializeRegionClipboard(clipboard, at);
    const viable = [];
    let skipped = 0;
    for (const it of placed) {
      const track = trackById(it.trackId) || song.tracks.find((t) => t.kind === it.kind);
      if (!track || track.kind !== it.kind) { skipped++; continue; }
      viable.push({ ...it, track });
    }
    if (!viable.length) {
      _toast("Nowhere to paste - the source tracks are gone", { severity: "error" });
      return;
    }
    pushState();
    const next = [];
    for (const it of viable) {
      const track = it.track;
      const spec = it.spec;
      spec.id = idc++;
      track.regions.push(spec);
      next.push({ trackId: track.id, regionId: spec.id });
    }
    sel = next;
    renderTimeline(); save();
    _toast(skipped ? `Pasted ${next.length}, skipped ${skipped} (missing track)` : `Pasted at ${formatMusicalPosition(at, beatsPerBar(), snapStep)}`, { severity: "ok" });
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
        if (r.takeActive === false) continue;
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
      markers: (song.markers || []).map((m) => ({
        tick: Math.round(m.beat * ticksPerQuarter),
        name: m.name,
      })),
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
    paintMeters();
    rafId = requestAnimationFrame(rafLoop);
  }

  function meterPercent(level) {
    const peak = typeof level === "number" ? level : (+level?.peak || +level?.rms || 0);
    if (!(peak > 0)) return 0;
    const db = 20 * Math.log10(peak);
    return Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  }

  function paintMeters() {
    if (!root || !engine) return;
    const snapshot = engine.meterSnapshot?.();
    const fallback = snapshot ? 0 : (engine.masterLevel?.() || 0);
    const tracks = snapshot?.tracks;
    root.querySelectorAll("[data-meter-track]").forEach((meter) => {
      const id = +meter.dataset.meterTrack;
      const level = tracks instanceof Map ? tracks.get(id) : tracks?.[id];
      const pct = meterPercent(level);
      const bar = meter.querySelector("i");
      if (bar) {
        if (meter.classList.contains("daw-channel-meter")) bar.style.height = pct + "%";
        else bar.style.width = pct + "%";
      }
      meter.classList.toggle("clip", (+level?.peak || 0) >= 0.995);
    });
    root.querySelectorAll("[data-meter-master]").forEach((meter) => {
      const level = snapshot?.master ?? fallback;
      const pct = meterPercent(level);
      const bar = meter.querySelector("i");
      if (bar) bar.style.height = pct + "%";
      meter.classList.toggle("clip", (+level?.peak || +level || 0) >= 0.995);
    });
    const legacy = root.querySelector("#daw-meter i");
    if (legacy) legacy.style.width = meterPercent(snapshot?.master ?? fallback) + "%";
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
      const inputLatencySec = Math.max(0, take.latencySec || 0);
      const latencySec = Math.max(0, inputLatencySec + startDeltaSec);
      const validDurationSec = Math.max(0.1, take.buffer.duration - latencySec);
      const lenBeats = Math.max(minLen(), snap(validDurationSec * (song.bpm / 60)));
      const completePasses = take.loop
        ? (take.passes || []).filter((pass) => pass.complete)
        : [];
      const captured = [];
      if (completePasses.length) {
        const loopLen = take.loop.b - take.loop.a;
        const secondsPerBeat = 60 / song.bpm;
        for (const pass of completePasses) {
          captured.push(makeRegion(t, snap(take.loop.a), loopLen, {
            name: `Take ${t.regions.length + 1}`,
            clipId,
            offset: inputLatencySec + pass.elapsedStart * secondsPerBeat,
          }));
        }
      } else {
        captured.push(makeRegion(t, startBeat, lenBeats, {
          name: `Take ${t.regions.length + 1}`,
          clipId,
          offset: latencySec,
        }));
      }
      for (const r of captured) {
        r.recordedTake = true;
        if (!stored) r.volatile = true;
      }
      const newest = captured[captured.length - 1];
      if (take.loop) registerLoopTake(t, newest);
      sel = [{ trackId: t.id, regionId: newest.id }];
    } else {
      const loopLen = take.loop ? take.loop.b - take.loop.a : null;
      const takeBeat = (b) => {
        const q = snap(b);
        return loopLen && q >= loopLen - 1e-7 ? 0 : Math.max(0, q);
      };
      const capturedPasses = (take.passes || []).filter((pass) =>
        (pass.notes || []).length || (pass.hits || []).length);
      const passContent = loopLen && capturedPasses.length
        ? capturedPasses
        : [{ notes: take.notes || [], hits: take.hits || [] }];
      const captured = [];
      for (const pass of passContent) {
        let len = loopLen || Math.max(beatsPerBar(), snap(take.lenBeats, "ceil"));
        const notes = (pass.notes || []).map((n) => ({ ...n, b: takeBeat(n.b) }));
        const hits = (pass.hits || []).map((h) => ({ ...h, b: takeBeat(h.b) }));
        if (!loopLen) {
          const contentEnd = Math.max(
            0,
            ...notes.map((n) => n.b + Math.max(MIN_SNAP, n.d || MIN_SNAP)),
            ...hits.map((h) => h.b + gridStep()),
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
        r.recordedTake = true;
        captured.push(r);
      }
      const newest = captured[captured.length - 1];
      if (take.loop) registerLoopTake(t, newest);
      sel = [{ trackId: t.id, regionId: newest.id }];
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

  function registerLoopTake(track, newest) {
    const peers = (track.regions || []).filter((r) =>
      r.recordedTake
      && Math.abs(r.start - newest.start) < 1e-6
      && Math.abs(r.len - newest.len) < 1e-6);
    if (peers.length < 2) return;
    const group = peers.find((r) => r.takeGroup != null)?.takeGroup || `take-${track.id}-${idc++}`;
    peers.sort((a, b) => a.id - b.id);
    peers.forEach((r, i) => {
      r.takeGroup = group;
      r.takeNo = i + 1;
      r.takeActive = r === newest;
      r.name = `Take ${i + 1}`;
    });
    if (!song.view.openTakeTrackIds.includes(track.id)) song.view.openTakeTrackIds.push(track.id);
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
      // Press position = velocity: near the key top is soft, the tip is loud.
      const kr = key.getBoundingClientRect();
      const vel = 0.45 + 0.55 * Math.max(0, Math.min(1, (e.clientY - kr.top) / Math.max(1, kr.height)));
      engine.noteOn(t, midi, vel);
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
    const activationTarget = e.target.closest?.("button, a[href], summary, [role='button'], [role='menuitem'], [role='tab']");
    // Let focused controls retain their native Enter/Space activation. The
    // transport shortcut is global only when focus is on the workspace.
    if (activationTarget && (e.code === "Space" || e.code === "Enter")) return;
    // Note cells own their editor-specific selection shortcut. This listener
    // runs in capture, so it must yield before the target handler sees Ctrl+A.
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyA" && e.target.closest?.(".daw-roll2-note")) return;
    // Studio-global shortcuts.
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyZ") { e.preventDefault(); e.stopPropagation(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && (e.code === "KeyY" || (e.shiftKey && e.code === "KeyZ"))) { e.preventDefault(); e.stopPropagation(); redo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyD") { e.preventDefault(); e.stopPropagation(); duplicateSelected(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyC") { e.preventDefault(); e.stopPropagation(); copySelected(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyX" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); cutSelected(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyV") { e.preventDefault(); e.stopPropagation(); pasteClipboard(); return; }
    if ((e.ctrlKey || e.metaKey) && e.code === "KeyA") {
      e.preventDefault(); e.stopPropagation();
      sel = song.tracks.flatMap((t) => (t.regions || []).map((r) => ({ trackId: t.id, regionId: r.id })));
      syncSelClasses();
      return;
    }
    if (e.code === "KeyQ" && !(e.ctrlKey || e.metaKey || e.altKey)) { e.preventDefault(); e.stopPropagation(); quantizeSelected(); return; }
    if (e.code === "KeyM" && !(e.ctrlKey || e.metaKey || e.altKey)) {
      e.preventDefault(); e.stopPropagation(); addMarkerAt(engine.beatNow()); return;
    }
    if (e.code === "Slash" && e.shiftKey && !(e.ctrlKey || e.metaKey || e.altKey)) {
      e.preventDefault(); e.stopPropagation(); showShortcutOverlay(); return;
    }
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
      const amount = e.shiftKey ? beatsPerBar() : gridStep();
      nudgeSelected(e.code === "ArrowLeft" ? -amount : amount);
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.code === "Space") { e.preventDefault(); e.stopPropagation(); togglePlay(); return; }
    if (e.code === "Home") { e.preventDefault(); e.stopPropagation(); engine.seek(0); if (el_.tl) el_.tl.scrollLeft = 0; updateClock(); return; }
    if (e.code === "End") {
      e.preventDefault(); e.stopPropagation();
      const end = songEnd();
      engine.seek(end);
      if (el_.tl) el_.tl.scrollLeft = Math.max(0, end * pxPerBeat - el_.tl.clientWidth + 120);
      updateClock();
      return;
    }
    if (e.code === "Delete" || e.code === "Backspace") {
      // Local editor controls own Delete. Focused toolbar/dialog controls also
      // must never delete the arrangement behind them.
      if (e.target.closest?.(".daw-roll2-note, .daw-automation-point, button, a[href], [role='button']")) return;
      e.stopPropagation();
      if (!deleteSelectedMarker()) deleteSelected();
      return;
    }
    if (e.code === "Escape") {
      if (editorOpen()) { closeEditor(); return; }
      sel = [];
      syncSelClasses();
      return;
    }
    if (e.code === "Enter" && primarySel()) {
      const track = trackById(primarySel().trackId);
      const region = regionById(track, primarySel().regionId);
      if (track && region) openEditor(track, region);
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
    engine.noteOn(t, midi, e.shiftKey ? 1 : 0.82);
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

  /* ------------- editor panel: piano roll v2 + audio region ------------- */
  const ROLL_KEYS_W = 46;
  const ROLL_VEL_H = 44;
  const BLACK_PCS = [1, 3, 6, 8, 10];
  let rollPx = 48;              // px per beat inside the roll (fit on open)
  let rollCtx = null;           // geometry + element maps for the open roll

  function openEditor(track, region) {
    if (editRegion !== region) rollSel = new Set();
    editRegion = region;
    bottom.active = "editor";
    bottom.h = Math.max(bottom.h, 280);   // the roll needs vertical room
    applyPanels();
    renderEditor();
    saveBottomState();
  }

  /** Short audition blip — noteOn with a scheduled noteOff so pads don't hang. */
  function auditionNote(track, midi) {
    engine.noteOn(track, midi, 0.9);
    setTimeout(() => { try { engine.noteOff(track, midi); } catch {} }, 240);
  }

  const rollNotesArr = () => (rollCtx.isDrums ? (rollCtx.r.hits ??= []) : (rollCtx.r.notes ??= []));
  const rollRowOf = (n) => (rollCtx.isDrums ? DRUM_KEYS.indexOf(n.k) : rollCtx.hiPitch - n.m);

  function renderEditor() {
    const p = el_.editor;
    const track = song.tracks.find((t) => (t.regions || []).includes(editRegion));
    if (!track || !editRegion) { closeEditor(); return; }
    const r = editRegion;
    p.innerHTML = "";
    rollCtx = null;

    const head = el("div", "daw-panel-head");
    const nameIn = el("input", "daw-region-rename");
    nameIn.value = r.name || "New Region";
    nameIn.setAttribute("aria-label", "Region name");
    nameIn.addEventListener("change", () => { pushState(); r.name = nameIn.value.slice(0, 32); renderTimeline(); save(); });
    head.append(el("span", "daw-panel-title", "EDIT — " + track.name), nameIn);

    const toolsWrap = el("div", "daw-roll-header-tools");
    if (track.kind === "midi") {
      const nLeft = iconBtn("daw-hbtn", "◀", "Shift notes left");
      nLeft.addEventListener("click", () => nudgeRegionNotes(-gridStep()));
      const nRight = iconBtn("daw-hbtn", "▶", "Shift notes right");
      nRight.addEventListener("click", () => nudgeRegionNotes(gridStep()));
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
    if (track.kind !== "audio") {
      const qBtn = iconBtn("daw-hbtn", "Q", "Quantize notes (Q)");
      qBtn.addEventListener("click", quantizeSelected);
      toolsWrap.appendChild(qBtn);
    }
    const close = iconBtn("daw-hbtn", "×", "Close editor");
    close.addEventListener("click", closeEditor);
    head.append(toolsWrap, close);

    if (track.kind === "audio") {
      p.append(head, buildAudioEditor(track, r));
      return;
    }

    /* ---- roll geometry ---- */
    const isDrums = track.kind === "drums";
    const ROW_H = isDrums ? 24 : 14;
    let rows;
    if (isDrums) {
      rows = DRUM_KEYS.map((k) => ({ key: k, label: DRUM_LABELS[k] }));
    } else {
      let lo = 127, hi = 0;
      for (const n of r.notes || []) { lo = Math.min(lo, n.m); hi = Math.max(hi, n.m); }
      if (lo > hi) { lo = 53; hi = 72; }
      lo = Math.max(12, lo - 7); hi = Math.min(108, hi + 7);
      while (hi - lo < 24) { if (hi < 108) hi++; else if (lo > 12) lo--; else break; }
      rows = [];
      for (let m = hi; m >= lo; m--) rows.push({ midi: m, label: keyName(m) });
    }
    const hiPitch = isDrums ? null : rows[0].midi;

    const scroll = el("div", "daw-roll2-scroll");
    const availW = Math.max(280, (p.clientWidth || root.clientWidth || 900) - 16);
    rollPx = Math.max(18, Math.min(96, (availW - ROLL_KEYS_W) / Math.max(1, r.len)));
    const innerW = ROLL_KEYS_W + r.len * rollPx;
    const innerH = rows.length * ROW_H;
    const inner = el("div", "daw-roll2");
    inner.style.width = innerW + "px";
    inner.style.height = innerH + "px";
    inner.tabIndex = 0;
    inner.setAttribute("role", "grid");
    inner.setAttribute("aria-label", isDrums ? "Drum note grid" : "Piano roll note grid");
    inner.setAttribute("aria-rowcount", String(rows.length));
    inner.setAttribute("aria-colcount", String(Math.max(1, Math.ceil(r.len / Math.max(MIN_SNAP, gridStep())))));

    const semanticRows = [];
    for (let i = 0; i < rows.length; i++) {
      const stripe = el("div", "daw-roll2-row" + (rows[i].midi != null && BLACK_PCS.includes(rows[i].midi % 12) ? " black" : ""));
      stripe.style.top = i * ROW_H + "px";
      stripe.style.height = ROW_H + "px";
      stripe.setAttribute("role", "row");
      stripe.setAttribute("aria-rowindex", String(i + 1));
      stripe.setAttribute("aria-label", isDrums ? rows[i].label : keyName(rows[i].midi));
      semanticRows.push(stripe);
      inner.appendChild(stripe);
    }
    const grid = el("div", "daw-roll2-grid");
    grid.style.left = ROLL_KEYS_W + "px";
    grid.style.width = r.len * rollPx + "px";
    grid.style.backgroundSize = `${beatsPerBar() * rollPx}px 100%, ${rollPx}px 100%`;
    inner.appendChild(grid);

    const notesLayer = el("div", "daw-roll2-notes");
    inner.appendChild(notesLayer);

    const keysCol = el("div", "daw-roll2-keys");
    keysCol.style.height = innerH + "px";
    rows.forEach((row, i) => {
      const isBlack = row.midi != null && BLACK_PCS.includes(row.midi % 12);
      const kl = el("button", "daw-roll2-key" + (isBlack ? " black" : ""),
        isDrums ? row.label : (row.midi % 12 === 0 ? row.label : ""));
      kl.type = "button";
      kl.setAttribute("aria-label", isDrums ? row.label : keyName(row.midi));
      kl.style.top = i * ROW_H + "px";
      kl.style.height = ROW_H + "px";
      kl.addEventListener("pointerdown", (e) => {
        e.stopPropagation(); e.preventDefault();
        auditionNote(track, isDrums ? i : row.midi);
        kl.classList.add("held");
      });
      kl.addEventListener("pointerup", () => kl.classList.remove("held"));
      kl.addEventListener("pointercancel", () => kl.classList.remove("held"));
      // Native button activation (keyboard and assistive technology) produces
      // a click with detail 0. Pointer audition already happens on pointerdown.
      kl.addEventListener("click", (e) => {
        if (e.detail !== 0) return;
        auditionNote(track, isDrums ? i : row.midi);
        kl.classList.add("held");
        setTimeout(() => kl.classList.remove("held"), 240);
      });
      keysCol.appendChild(kl);
    });
    inner.appendChild(keysCol);
    scroll.appendChild(inner);

    const velWrap = el("div", "daw-vel2");
    velWrap.appendChild(el("span", "daw-vel2-label", "VEL"));
    const velClip = el("div", "daw-vel2-clip");
    const velCv = el("canvas", "daw-vel2-cv");
    velCv.setAttribute("aria-label", "Velocity lane — drag to set note velocity");
    velClip.appendChild(velCv);
    velWrap.appendChild(velClip);

    scroll.addEventListener("scroll", () => {
      keysCol.style.transform = `translateX(${scroll.scrollLeft}px)`;
      paintVelLane();
    });

    rollCtx = {
      track, r, rows, ROW_H, isDrums, hiPitch, inner, notesLayer, semanticRows,
      scroll, velCv, noteEls: new Map(),
    };
    renderRollNotes();
    attachRollInteractions();

    p.append(head, scroll, velWrap);
    requestAnimationFrame(() => {
      if (!isDrums) {
        const mids = (r.notes || []).map((n) => n.m);
        const ctr = mids.length ? (Math.min(...mids) + Math.max(...mids)) / 2 : 62;
        scroll.scrollTop = Math.max(0, (hiPitch - ctr) * ROW_H - scroll.clientHeight / 2);
      }
      sizeVelCanvas();
      paintVelLane();
    });
  }

  function renderRollNotes() {
    const { notesLayer } = rollCtx;
    notesLayer.innerHTML = "";
    for (const row of rollCtx.semanticRows) row.removeAttribute("aria-owns");
    rollCtx.noteEls = new Map();
    const arr = rollNotesArr();
    rollSel = new Set([...rollSel].filter((n) => arr.includes(n)));
    const tabbable = [...rollSel][0] || arr[0] || null;
    const rowCells = rollCtx.semanticRows.map(() => []);
    for (let noteIndex = 0; noteIndex < arr.length; noteIndex++) {
      const n = arr[noteIndex];
      const d = rollNoteEl(n);
      d.id = `daw-roll-cell-${rollCtx.track.id}-${rollCtx.r.id}-${noteIndex}`;
      d.tabIndex = n === tabbable ? 0 : -1;
      rollCtx.noteEls.set(n, d);
      notesLayer.appendChild(d);
      const row = rollRowOf(n);
      if (rowCells[row]) rowCells[row].push(d.id);
    }
    rowCells.forEach((ids, row) => {
      if (ids.length) rollCtx.semanticRows[row].setAttribute("aria-owns", ids.join(" "));
    });
  }

  function rollNoteEl(n) {
    const d = el("div", "daw-roll2-note" + (rollSel.has(n) ? " rsel" : "") + (rollCtx.isDrums ? " hit" : ""));
    d.tabIndex = 0;
    d.setAttribute("role", "gridcell");
    d.setAttribute("aria-selected", String(rollSel.has(n)));
    d.setAttribute("aria-rowindex", String(rollRowOf(n) + 1));
    d.setAttribute("aria-colindex", String(Math.max(1, Math.round(n.b / Math.max(MIN_SNAP, gridStep())) + 1)));
    d._note = n;
    positionNoteEl(d, n);
    updateNoteAria(d, n);
    d.addEventListener("keydown", (e) => rollNoteKeydown(e, n));
    return d;
  }

  function positionNoteEl(d, n) {
    const { ROW_H, isDrums } = rollCtx;
    const row = rollRowOf(n);
    d.style.left = ROLL_KEYS_W + n.b * rollPx + "px";
    d.style.top = row * ROW_H + 1 + "px";
    d.style.height = ROW_H - 2 + "px";
    d.style.width = isDrums ? ROW_H - 2 + "px" : Math.max(4, (n.d || MIN_SNAP) * rollPx - 1) + "px";
    d.style.opacity = 0.55 + 0.45 * Math.min(1, n.v ?? 1);
  }

  function updateNoteAria(d, n) {
    const { isDrums } = rollCtx;
    const what = isDrums ? DRUM_LABELS[n.k] : keyName(n.m);
    const len = isDrums ? "" : `, ${(n.d || MIN_SNAP).toFixed(2)} beats`;
    d.setAttribute("aria-selected", String(rollSel.has(n)));
    d.setAttribute("aria-rowindex", String(rollRowOf(n) + 1));
    d.setAttribute("aria-colindex", String(Math.max(1, Math.round(n.b / Math.max(MIN_SNAP, gridStep())) + 1)));
    d.setAttribute("aria-label", `${what}, beat ${(n.b + 1).toFixed(2)}${len}, velocity ${Math.round((n.v ?? 1) * 127)}`);
  }

  function sizeVelCanvas() {
    const { velCv, scroll } = rollCtx;
    // Keep the bitmap viewport-sized. A song can be arbitrarily wide, but
    // browser canvases cannot; paintVelLane accounts for horizontal scroll.
    const w = Math.max(1, velCv.parentElement?.clientWidth || scroll.clientWidth || 300);
    const dpr = devicePixelRatio || 1;
    velCv.width = Math.ceil(w * dpr);
    velCv.height = Math.ceil(ROLL_VEL_H * dpr);
    velCv.style.width = w + "px";
    velCv.style.height = ROLL_VEL_H + "px";
  }

  function paintVelLane() {
    const { velCv, scroll } = rollCtx || {};
    if (!velCv) return;
    sizeVelCanvas();
    const g = velCv.getContext("2d");
    const dpr = devicePixelRatio || 1;
    g.save();
    g.scale(dpr, dpr);
    const w = velCv.width / dpr, h = ROLL_VEL_H;
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    const colBase = css.getPropertyValue("--sx-brand-a").trim() || "#4cc";
    const colSel = css.getPropertyValue("--sx-hot").trim() || "#f4a";
    for (const n of rollNotesArr()) {
      const x = ROLL_KEYS_W + n.b * rollPx - scroll.scrollLeft;
      if (x < -4 || x > w + 4) continue;
      const v = Math.max(0.02, Math.min(1, n.v ?? 1));
      g.fillStyle = rollSel.has(n) ? colSel : colBase;
      g.globalAlpha = rollSel.size && !rollSel.has(n) ? 0.45 : 0.95;
      g.fillRect(x, h - 2 - v * (h - 4), 3, v * (h - 4));
    }
    g.restore();
  }

  function attachRollInteractions() {
    const { inner, rows, ROW_H, isDrums, track, r, velCv } = rollCtx;
    inner.addEventListener("contextmenu", (e) => e.preventDefault());
    let rdrag = null;

    const beatAt = (e) => {
      const rect = inner.getBoundingClientRect();
      return Math.max(0, (e.clientX - rect.left - ROLL_KEYS_W) / rollPx);
    };
    const rowAt = (e) => {
      const rect = inner.getBoundingClientRect();
      return Math.max(0, Math.min(rows.length - 1, Math.floor((e.clientY - rect.top) / ROW_H)));
    };
    // Pointer capture retargets move events to `inner`, so hit-testing during
    // a drag must go through elementFromPoint, not e.target.
    const noteUnder = (e) => document.elementFromPoint(e.clientX, e.clientY)?.closest?.(".daw-roll2-note") || null;

    const eraseNote = (noteEl) => {
      const n = noteEl?._note;
      if (!n) return;
      if (!rdrag.pushed) { pushState(); rdrag.pushed = true; }
      const arr = rollNotesArr();
      const i = arr.indexOf(n);
      if (i >= 0) arr.splice(i, 1);
      rollSel.delete(n);
      rollCtx.noteEls.delete(n);
      noteEl.remove();
      paintVelLane();
    };

    inner.addEventListener("pointerdown", (e) => {
      if (e.target.closest?.(".daw-roll2-keys")) return;
      const noteEl = e.target.closest?.(".daw-roll2-note");
      try { inner.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
      if (e.button === 2) {
        rdrag = { mode: "erase", pushed: false };
        eraseNote(noteEl);
        return;
      }
      if (e.button !== 0) return;

      if (noteEl) {
        const n = noteEl._note;
        const rect = noteEl.getBoundingClientRect();
        const nearRight = !isDrums && e.clientX > rect.right - 7 && rect.width > 14;
        if (e.shiftKey) {
          if (rollSel.has(n)) rollSel.delete(n); else rollSel.add(n);
          renderRollNotes(); paintVelLane();
          return;
        }
        if (!rollSel.has(n)) { rollSel = new Set([n]); renderRollNotes(); paintVelLane(); }
        const targets = [...rollSel];
        const pushed = false;
        const origs = targets.map((t0) => ({ n: t0, b0: t0.b, d0: t0.d, m0: t0.m, k0: t0.k }));
        rdrag = nearRight
          ? { mode: "resize", origs, startBeat: beatAt(e), pushed }
          : { mode: "movenotes", origs, startBeat: beatAt(e), startRow: rowAt(e), pushed,
              duplicate: !!e.altKey, cloned: false };
        return;
      }

      if (e.ctrlKey || e.metaKey) {
        const rect = inner.getBoundingClientRect();
        const mEl = el("div", "daw-marquee");
        inner.appendChild(mEl);
        if (!e.shiftKey) { rollSel = new Set(); renderRollNotes(); paintVelLane(); }
        rdrag = { mode: "rmarquee", x0: e.clientX - rect.left, y0: e.clientY - rect.top, el: mEl, base: new Set(rollSel) };
        return;
      }

      // ---- create ----
      pushState();
      const b = Math.min(Math.max(0, r.len - MIN_SNAP), snap(beatAt(e), "floor"));
      const row = rows[rowAt(e)];
      let n;
      if (isDrums) n = { b, k: row.key, v: 1 };
      else n = { b, d: Math.max(MIN_SNAP, Math.min(lastNoteLen, r.len - b)), m: row.midi, v: 0.9 };
      rollNotesArr().push(n);
      rollSel = new Set([n]);
      renderRollNotes(); paintVelLane();
      auditionNote(track, isDrums ? DRUM_KEYS.indexOf(row.key) : row.midi);
      rdrag = { mode: "create", n, anchor: b, x0: e.clientX, moved: false, pushed: true };
    });

    inner.addEventListener("pointermove", (e) => {
      if (!rdrag) return;
      if (rdrag.mode === "erase") { eraseNote(noteUnder(e)); return; }
      if (rdrag.mode === "rmarquee") {
        const rect = inner.getBoundingClientRect();
        const x1 = e.clientX - rect.left, y1 = e.clientY - rect.top;
        const bx = Math.min(rdrag.x0, x1), by = Math.min(rdrag.y0, y1);
        const bw = Math.abs(x1 - rdrag.x0), bh = Math.abs(y1 - rdrag.y0);
        Object.assign(rdrag.el.style, { left: bx + "px", top: by + "px", width: bw + "px", height: bh + "px" });
        const b0 = (bx - ROLL_KEYS_W) / rollPx, b1 = (bx + bw - ROLL_KEYS_W) / rollPx;
        const r0 = Math.floor(by / ROW_H), r1 = Math.floor((by + bh) / ROW_H);
        const picked = rollNotesArr().filter((n) => {
          const row = rollRowOf(n);
          const nEnd = n.b + (n.d ?? 0.2);
          return row >= r0 && row <= r1 && n.b < b1 && nEnd > b0;
        });
        rollSel = new Set([...rdrag.base, ...picked]);
        for (const [n, elN] of rollCtx.noteEls) elN.classList.toggle("rsel", rollSel.has(n));
        paintVelLane();
        return;
      }
      const beat = beatAt(e);
      if (rdrag.mode === "create") {
        if (!rdrag.moved && Math.abs(e.clientX - rdrag.x0) < 4) return;
        rdrag.moved = true;
        const n = rdrag.n;
        if (!isDrums) {
          const end = Math.max(n.b + MIN_SNAP, snap(beat, "ceil"));
          n.d = Math.min(Math.max(MIN_SNAP, end - n.b), r.len - n.b);
          const elN = rollCtx.noteEls.get(n);
          if (elN) { positionNoteEl(elN, n); updateNoteAria(elN, n); }
        }
        return;
      }
      if (rdrag.mode === "movenotes") {
        const rawDb = beat - rdrag.startBeat;
        let db = snapStep > 0 ? Math.round(rawDb / snapStep) * snapStep : rawDb;
        let dr = rowAt(e) - rdrag.startRow;
        for (const o of rdrag.origs) {
          db = Math.max(db, -o.b0);
          db = Math.min(db, Math.max(0, r.len - MIN_SNAP - o.b0));
          const row0 = isDrums ? DRUM_KEYS.indexOf(o.k0) : rollCtx.hiPitch - o.m0;
          dr = Math.max(dr, -row0);
          dr = Math.min(dr, rows.length - 1 - row0);
        }
        const wouldChange = rdrag.origs.some((o) =>
          o.n.b !== o.b0 + db ||
          (isDrums ? o.n.k !== rows[DRUM_KEYS.indexOf(o.k0) + dr].key : o.n.m !== o.m0 - dr));
        if (!wouldChange) return;
        if (rdrag.duplicate && !rdrag.cloned) {
          pushState(); rdrag.pushed = true;
          const clones = rdrag.origs.map((o) => ({ ...o.n }));
          rollNotesArr().push(...clones);
          rollSel = new Set(clones);
          rdrag.origs = clones.map((clone, i) => ({
            n: clone,
            b0: rdrag.origs[i].b0,
            d0: rdrag.origs[i].d0,
            m0: rdrag.origs[i].m0,
            k0: rdrag.origs[i].k0,
          }));
          rdrag.cloned = true;
          renderRollNotes();
        } else if (!rdrag.pushed) {
          pushState(); rdrag.pushed = true;
        }
        let pitchChanged = false;
        for (const o of rdrag.origs) {
          o.n.b = o.b0 + db;
          if (isDrums) {
            const nk = rows[DRUM_KEYS.indexOf(o.k0) + dr].key;
            if (o.n.k !== nk) pitchChanged = true;
            o.n.k = nk;
          } else {
            const nm = o.m0 - dr;
            if (o.n.m !== nm) pitchChanged = true;
            o.n.m = nm;
            o.n.d = Math.max(MIN_SNAP, Math.min(o.d0, r.len - o.n.b));
          }
          const elN = rollCtx.noteEls.get(o.n);
          if (elN) { positionNoteEl(elN, o.n); updateNoteAria(elN, o.n); }
        }
        if (pitchChanged && rdrag.origs.length === 1) {
          const o = rdrag.origs[0];
          auditionNote(track, isDrums ? DRUM_KEYS.indexOf(o.n.k) : o.n.m);
        }
        paintVelLane();
        return;
      }
      if (rdrag.mode === "resize") {
        const rawDd = beat - rdrag.startBeat;
        const dd = snapStep > 0 ? Math.round(rawDd / snapStep) * snapStep : rawDd;
        const wouldChange = rdrag.origs.some((o) =>
          o.n.d !== Math.max(MIN_SNAP, Math.min((o.d0 || MIN_SNAP) + dd, r.len - o.b0)));
        if (!wouldChange) return;
        if (!rdrag.pushed) { pushState(); rdrag.pushed = true; }
        for (const o of rdrag.origs) {
          o.n.d = Math.max(MIN_SNAP, Math.min((o.d0 || MIN_SNAP) + dd, r.len - o.b0));
          const elN = rollCtx.noteEls.get(o.n);
          if (elN) { positionNoteEl(elN, o.n); updateNoteAria(elN, o.n); }
        }
      }
    });

    const rfinish = () => {
      if (!rdrag) return;
      const d0 = rdrag; rdrag = null;
      const focusedNote = document.activeElement?._note || null;
      if (d0.mode === "rmarquee") d0.el.remove();
      if (!rollCtx.isDrums) {
        if (d0.mode === "create" && d0.n && d0.moved) lastNoteLen = d0.n.d;
        if (d0.mode === "resize" && d0.origs[0]?.n) lastNoteLen = d0.origs[0].n.d;
      }
      // Pointer edits update note geometry in place for smooth dragging. Once
      // the gesture ends, rebuild the cells so selection state, row/column
      // indices and each semantic row's aria-owns list all match the model.
      if (["rmarquee", "movenotes", "resize", "erase"].includes(d0.mode)) {
        renderRollNotes();
        paintVelLane();
        if (focusedNote) rollCtx.noteEls.get(focusedNote)?.focus();
      }
      if (d0.mode === "rmarquee") return;
      if (d0.pushed) { redrawRegion(rollCtx.track, rollCtx.r); save(); }
    };
    inner.addEventListener("pointerup", rfinish);
    inner.addEventListener("pointercancel", rfinish);

    /* ---- velocity lane pointer ---- */
    let veldrag = null;
    const velApply = (e) => {
      const rect = velCv.getBoundingClientRect();
      const beat = (e.clientX - rect.left - ROLL_KEYS_W + rollCtx.scroll.scrollLeft) / rollPx;
      const tol = 6 / rollPx;
      let targets = rollNotesArr().filter((n) => Math.abs(n.b - beat) <= tol);
      if (!targets.length) return;
      if (rollSel.size && targets.some((n) => rollSel.has(n))) targets = targets.filter((n) => rollSel.has(n));
      const v = Math.max(0.05, Math.min(1, 1 - (e.clientY - rect.top - 2) / (ROLL_VEL_H - 4)));
      if (!veldrag.pushed) { pushState(); veldrag.pushed = true; }
      for (const n of targets) {
        n.v = v;
        const elN = rollCtx.noteEls.get(n);
        if (elN) { elN.style.opacity = 0.55 + 0.45 * v; updateNoteAria(elN, n); }
      }
      paintVelLane();
    };
    velCv.addEventListener("pointerdown", (e) => {
      veldrag = { pushed: false };
      velApply(e);
      try { velCv.setPointerCapture(e.pointerId); } catch {}
      e.preventDefault();
    });
    velCv.addEventListener("pointermove", (e) => { if (veldrag) velApply(e); });
    const velUp = () => {
      if (veldrag?.pushed) save();
      veldrag = null;
    };
    velCv.addEventListener("pointerup", velUp);
    velCv.addEventListener("pointercancel", velUp);
  }

  function rollNoteKeydown(e, n) {
    if (!rollCtx) return;
    const { track, r, isDrums, rows } = rollCtx;
    const targets = rollSel.has(n) ? [...rollSel] : [n];
    const isSel = (x) => targets.includes(x);
    const step = gridStep();
    const arr = rollNotesArr();
    const focusIndex = arr.indexOf(n);

    if ((e.ctrlKey || e.metaKey) && e.code === "KeyA") {
      e.preventDefault(); e.stopPropagation();
      rollSel = new Set(arr);
      renderRollNotes(); paintVelLane();
      rollCtx.noteEls.get(n)?.focus();
      return;
    }

    if (e.key === "Delete" || e.key === "Backspace") {
      e.preventDefault(); e.stopPropagation();
      pushState();
      for (const t0 of targets) {
        const i = arr.indexOf(t0);
        if (i >= 0) arr.splice(i, 1);
        rollSel.delete(t0);
      }
      renderRollNotes(); paintVelLane(); redrawRegion(track, r); save();
      const survivor = rollNotesArr()[Math.min(Math.max(0, focusIndex), Math.max(0, rollNotesArr().length - 1))];
      (survivor ? rollCtx.noteEls.get(survivor) : rollCtx.inner)?.focus();
      return;
    }
    let db = 0, dp = 0, dd = 0;
    if (e.key === "ArrowLeft") { if (e.shiftKey) dd = -step; else db = -step; }
    else if (e.key === "ArrowRight") { if (e.shiftKey) dd = step; else db = step; }
    else if (e.key === "ArrowUp") dp = 1;
    else if (e.key === "ArrowDown") dp = -1;
    else return;
    e.preventDefault(); e.stopPropagation();
    pushStateGesture("rollkb");

    if (isDrums && dp) {
      // Hits move between drum rows in place (identities preserved).
      let dr = -dp;
      for (const t0 of targets) {
        const row0 = DRUM_KEYS.indexOf(t0.k);
        dr = Math.max(dr, -row0);
        dr = Math.min(dr, rows.length - 1 - row0);
      }
      for (const t0 of targets) t0.k = rows[DRUM_KEYS.indexOf(t0.k) + dr].key;
    } else if (dd && !isDrums) {
      const out = resizeSelectedNotes(arr, isSel, dd, r.len);
      replaceRollNotes(arr, out, targets);
    } else {
      if (!isDrums && dp) {
        const loPitch = rows[rows.length - 1].midi;
        const hiPitch = rollCtx.hiPitch;
        for (const t0 of targets) {
          dp = Math.max(dp, loPitch - t0.m);
          dp = Math.min(dp, hiPitch - t0.m);
        }
      }
      const out = shiftSelectedNotes(arr, isSel, db, dp, r.len);
      replaceRollNotes(arr, out, targets);
    }
    renderRollNotes(); paintVelLane(); redrawRegion(track, r); save();
    // Restore focus so arrow keys keep working on the same note.
    const focusNote = rollNotesArr()[focusIndex] ?? [...rollSel][0];
    if (focusNote) rollCtx.noteEls.get(focusNote)?.focus();
  }

  /** Pure note helpers return new objects — swap them in and remap selection. */
  function replaceRollNotes(oldArr, newArr, oldTargets) {
    const nextSel = new Set();
    for (let i = 0; i < oldArr.length; i++) {
      if (oldTargets.includes(oldArr[i])) nextSel.add(newArr[i]);
    }
    if (rollCtx.isDrums) rollCtx.r.hits = newArr;
    else rollCtx.r.notes = newArr;
    rollSel = nextSel;
  }

  /* ---- audio region editor: clip gain + fades over the waveform ---- */
  function buildAudioEditor(track, r) {
    const body = el("div", "daw-audio-ed");
    const cv = el("canvas", "daw-audio-ed-cv");
    const repaint = () => { drawAudioEditorWave(cv, r); redrawRegion(track, r); };
    const fadeMax = Math.max(0.25, Math.min(8, r.len));
    const knobs = el("div", "daw-knobs daw-audio-ed-knobs");
    knobs.append(
      knob("Clip Gain", () => r.gain ?? 1, (v) => { r.gain = v; repaint(); }, {
        min: 0, max: 2,
        fmt: (v) => (v <= 0.001 ? "-inf dB" : (20 * Math.log10(v)).toFixed(1) + " dB"),
      }),
      knob("Fade In", () => r.fadeIn || 0, (v) => { r.fadeIn = clampedFade(r.len, r.fadeOut || 0, v); repaint(); }, {
        min: 0, max: fadeMax, fmt: (v) => v.toFixed(2) + " beats",
      }),
      knob("Fade Out", () => r.fadeOut || 0, (v) => { r.fadeOut = clampedFade(r.len, r.fadeIn || 0, v); repaint(); }, {
        min: 0, max: fadeMax, fmt: (v) => v.toFixed(2) + " beats",
      }),
    );
    const tempo = el("button", "daw-tempo-mode");
    tempo.type = "button";
    const paintTempo = () => {
      const rate = r.tempoMode === "repitch" ? song.bpm / (r.sourceBpm || song.bpm) : 1;
      const semis = 12 * Math.log2(Math.max(0.001, rate));
      tempo.textContent = r.tempoMode === "repitch"
        ? `FOLLOW BPM · REPITCH ${rate.toFixed(2)}× (${semis >= 0 ? "+" : ""}${semis.toFixed(1)} st)`
        : "FOLLOW BPM · OFF (RAW)";
      tempo.setAttribute("aria-pressed", r.tempoMode === "repitch" ? "true" : "false");
    };
    tempo.addEventListener("click", () => {
      pushState();
      r.tempoMode = r.tempoMode === "repitch" ? "raw" : "repitch";
      paintTempo();
      engine?.syncGraph?.();
      redrawRegion(track, r); save();
    });
    paintTempo();
    body.append(cv, knobs, tempo);
    requestAnimationFrame(() => drawAudioEditorWave(cv, r));
    return body;
  }

  function drawAudioEditorWave(cv, r) {
    const w = Math.max(120, cv.clientWidth || cv.parentElement?.clientWidth || 400);
    const h = Math.max(48, cv.clientHeight || 72);
    const dpr = devicePixelRatio || 1;
    cv.width = w * dpr; cv.height = h * dpr;
    const g = cv.getContext("2d");
    if (!g) return;
    g.scale(dpr, dpr);
    g.clearRect(0, 0, w, h);
    const css = getComputedStyle(document.documentElement);
    g.strokeStyle = g.fillStyle = css.getPropertyValue("--sx-brand-a").trim() || "#4cc";
    const clip = clips.get(r.clipId);
    if (!clip) {
      g.globalAlpha = 0.4;
      g.fillRect(0, h / 2 - 1, w, 2);
      return;
    }
    const data = clip.getChannelData(0);
    const start = Math.floor((r.offset || 0) * clip.sampleRate);
    const sourceSpb = r.tempoMode === "repitch" ? 60 / (r.sourceBpm || song.bpm) : 60 / song.bpm;
    const span = Math.max(1, Math.min(data.length - start, Math.floor(r.len * sourceSpb * clip.sampleRate)));
    const step = Math.max(1, Math.floor(span / w));
    const gain = Math.max(0.05, Math.min(2, r.gain ?? 1));
    const fiX = (Math.max(0, r.fadeIn || 0) / r.len) * w;
    const foX = (Math.max(0, r.fadeOut || 0) / r.len) * w;
    g.globalAlpha = 0.9;
    g.beginPath();
    for (let x = 0; x < w; x++) {
      let peak = 0;
      const s0 = start + x * step;
      for (let i = 0; i < step && s0 + i < data.length; i += 4) peak = Math.max(peak, Math.abs(data[s0 + i]));
      // show the fade's effect on the drawn envelope
      let env = 1;
      if (fiX > 0 && x < fiX) env = x / fiX;
      if (foX > 0 && x > w - foX) env = Math.min(env, (w - x) / foX);
      const y = Math.min(1, peak * gain * env) * (h / 2 - 3);
      g.moveTo(x, h / 2 - y);
      g.lineTo(x, h / 2 + y + 0.5);
    }
    g.stroke();
    if (fiX > 1 || foX > 1) {
      g.globalAlpha = 1;
      g.lineWidth = 1.4;
      g.beginPath();
      if (fiX > 1) { g.moveTo(0, h - 2); g.lineTo(fiX, 2); }
      if (foX > 1) { g.moveTo(w, h - 2); g.lineTo(w - foX, 2); }
      g.stroke();
    }
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

  function renderMixer() {
    const p = el_.mixer;
    if (!p) return;
    p.innerHTML = "";
    const head = el("div", "daw-panel-head");
    head.append(el("span", "daw-panel-title", "MIXER"), el("span", "daw-mixer-note", "Post-fader shared sends · DAW master → safety limiter"));
    const close = iconBtn("daw-hbtn", "×", "Hide mixer");
    close.addEventListener("click", () => toggleBottomPanel("mixer"));
    head.appendChild(close);
    const body = el("div", "daw-mixer-body");
    for (const track of song.tracks) body.appendChild(mixerTrackStrip(track));
    body.append(
      mixerReturnStrip("REVERB", song.buses.reverb, "return", () => engine?.refreshMixParams?.()),
      mixerReturnStrip("DELAY", song.buses.delay, "return", () => engine?.refreshMixParams?.()),
      mixerMasterStrip(),
    );
    p.append(head, body);
  }

  function mixerTrackStrip(track) {
    const strip = el("section", "daw-channel" + (track.id === activeTrackId ? " active" : ""));
    strip.style.setProperty("--tc", TRACK_COLORS[track.color % TRACK_COLORS.length]);
    strip.addEventListener("pointerdown", () => setActiveTrack(track.id));
    const name = el("strong", "daw-channel-name", track.name);
    const meter = el("div", "daw-channel-meter");
    meter.dataset.meterTrack = track.id;
    meter.append(el("i"), el("b"));
    meter.setAttribute("aria-label", `${track.name} level meter`);
    const buttons = el("div", "daw-channel-buttons");
    const mixButton = (label, pressed, fn, cls = "") => {
      const b = el("button", `daw-channel-btn ${cls}`, label);
      b.type = "button";
      b.classList.toggle("active", !!pressed);
      b.setAttribute("aria-pressed", pressed ? "true" : "false");
      b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
      return b;
    };
    buttons.append(
      mixButton("M", track.mute, () => { pushState(); track.mute = !track.mute; engine.refreshTrackParams(); renderHeads(); renderMixer(); save(); }, "mute"),
      mixButton("S", track.solo, () => { pushState(); track.solo = !track.solo; engine.refreshTrackParams(); renderHeads(); renderMixer(); save(); }, "solo"),
      mixButton("FX", !track.fx?.bypass, () => {
        pushState(); track.fx.bypass = !track.fx.bypass; engine?.syncGraph?.(); renderMixer(); save();
      }, "fx"),
    );
    const fader = mixerSlider("Fader", track.gain, 0, 1.4, 0.01, (value) => {
      track.gain = value; engine.refreshMixParams?.() || engine.refreshTrackParams();
    }, true);
    const pan = mixerSlider("Pan", track.pan, -1, 1, 0.01, (value) => {
      track.pan = value; engine.refreshMixParams?.() || engine.refreshTrackParams();
    });
    const reverb = mixerSlider("Verb", track.sends.reverb, 0, 1, 0.01, (value) => {
      track.sends.reverb = value; engine.refreshMixParams?.() || engine.refreshTrackParams();
    });
    const delay = mixerSlider("Delay", track.sends.delay, 0, 1, 0.01, (value) => {
      track.sends.delay = value; engine.refreshMixParams?.() || engine.refreshTrackParams();
    });
    strip.append(name, meter, fader, pan, reverb, delay, buttons);
    return strip;
  }

  function mixerSlider(label, value, min, max, step, set, vertical = false) {
    const wrap = el("label", `daw-mixer-control${vertical ? " vertical" : ""}`);
    const title = el("span", null, label);
    const input = el("input");
    input.type = "range";
    input.min = min; input.max = max; input.step = step; input.value = value;
    input.setAttribute("aria-label", label);
    const output = el("output");
    const paint = () => {
      const v = +input.value;
      output.textContent = label === "Fader"
        ? (v <= 0.001 ? "−∞" : `${(20 * Math.log10(v)).toFixed(1)} dB`)
        : label.endsWith("EQ")
          ? `${v > 0 ? "+" : ""}${v.toFixed(1)} dB`
        : label === "Pan"
          ? (Math.abs(v) < 0.02 ? "C" : `${v < 0 ? "L" : "R"}${Math.round(Math.abs(v) * 100)}`)
          : label === "Time"
            ? `${v.toFixed(2)} beats`
            : label === "Tone"
              ? fmtHz(v)
          : `${Math.round(v * 100)}%`;
    };
    let pushed = false;
    input.addEventListener("pointerdown", (e) => { e.stopPropagation(); pushState(); pushed = true; });
    input.addEventListener("keydown", (e) => {
      if (/^(Arrow|Home$|End$|Page)/.test(e.key)) pushStateGesture(`mixer:${label}`);
    });
    input.addEventListener("input", () => { set(+input.value); paint(); });
    input.addEventListener("change", () => { if (!pushed) pushStateGesture(`mixer:${label}`); pushed = false; save(); });
    paint();
    wrap.append(title, input, output);
    return wrap;
  }

  function mixerReturnStrip(name, bus, key, refresh) {
    const strip = el("section", "daw-channel daw-return");
    const title = el("strong", "daw-channel-name", name);
    const on = el("button", "daw-channel-btn", bus.on === false ? "OFF" : "ON");
    on.type = "button";
    on.classList.toggle("active", bus.on !== false);
    on.setAttribute("aria-pressed", bus.on !== false ? "true" : "false");
    on.addEventListener("click", () => { pushState(); bus.on = bus.on === false; refresh(); renderMixer(); save(); });
    strip.append(title, mixerSlider("Fader", bus[key] ?? 1, 0, 1.4, 0.01, (v) => { bus[key] = v; refresh(); }, true));
    if (name === "REVERB") {
      strip.append(
        mixerSlider("Size", bus.size ?? 0.4, 0, 1, 0.01, (v) => { bus.size = v; queueReverbRebuild(); refresh(); }),
        mixerSlider("Damp", bus.damp ?? 0.5, 0, 1, 0.01, (v) => { bus.damp = v; queueReverbRebuild(); refresh(); }),
      );
    } else {
      strip.append(
        mixerSlider("Time", bus.time ?? 0.25, 0.0625, 2, 0.0625, (v) => { bus.time = v; refresh(); }),
        mixerSlider("Feedback", bus.feedback ?? 0.3, 0, 0.88, 0.01, (v) => { bus.feedback = v; refresh(); }),
      );
    }
    strip.append(on);
    return strip;
  }

  function queueReverbRebuild() {
    clearTimeout(reverbRebuildTimer);
    reverbRebuildTimer = setTimeout(() => engine?.rebuildReverbBus?.(), 180);
  }

  function mixerMasterStrip() {
    const master = song.master;
    const strip = el("section", "daw-channel daw-master-channel");
    const title = el("strong", "daw-channel-name", "DAW MASTER");
    const limiter = el("span", "daw-limiter-badge", "LIMITER · ON");
    const masterHead = el("div", "daw-master-head");
    masterHead.append(title, limiter);
    const meter = el("div", "daw-channel-meter master");
    meter.dataset.meterMaster = "true";
    meter.append(el("i"), el("b"));
    meter.setAttribute("aria-label", "DAW master level meter");
    const eqToggle = el("button", "daw-channel-btn", master.eq.on === false ? "EQ · OFF" : "EQ · ON");
    eqToggle.type = "button";
    eqToggle.classList.toggle("active", master.eq.on !== false);
    eqToggle.setAttribute("aria-pressed", master.eq.on !== false ? "true" : "false");
    eqToggle.addEventListener("click", () => {
      pushState(); master.eq.on = master.eq.on === false; engine?.refreshMixParams?.(); renderMixer(); save();
    });
    strip.append(
      masterHead,
      meter,
      mixerSlider("Fader", master.gain, 0, 1.4, 0.01, (v) => { master.gain = v; engine?.refreshMixParams?.(); }, true),
      mixerSlider("Low EQ", master.eq.low, -18, 18, 0.5, (v) => { master.eq.low = v; engine?.refreshMixParams?.(); }),
      mixerSlider("Mid EQ", master.eq.mid, -18, 18, 0.5, (v) => { master.eq.mid = v; engine?.refreshMixParams?.(); }),
      mixerSlider("High EQ", master.eq.high, -18, 18, 0.5, (v) => { master.eq.high = v; engine?.refreshMixParams?.(); }),
      eqToggle,
    );
    return strip;
  }

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

    // Shared send levels. The actual delay and reverb processors live once on
    // the DAW buses and are controlled from the mixer.
    const delEl = el("div", "daw-device daw-effect");
    const delHead = el("div", "daw-device-head");
    delHead.append(el("strong", null, "Shared Sends"));
    const delBody = el("div", "daw-device-body daw-knobs");
    const delSet = (fn) => (v) => { fn(v); engine.refreshMixParams?.() || engine.refreshTrackParams(); };
    delBody.append(
      knob("Reverb", () => t.sends.reverb, delSet((v) => (t.sends.reverb = v)), { min: 0, max: 1, fmt: (v) => Math.round(v * 100) + "%" }),
      knob("Delay", () => t.sends.delay, delSet((v) => (t.sends.delay = v)), { min: 0, max: 1, fmt: (v) => Math.round(v * 100) + "%" }),
    );
    delEl.append(delHead, delBody);
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

    // Shared bus settings belong to the mixer, not one copy per track.
    const rv = el("div", "daw-device daw-effect");
    const rvHead = el("div", "daw-device-head");
    rvHead.append(el("strong", null, "Shared Returns"));
    const rvBody = el("div", "daw-device-body daw-shared-return");
    rvBody.append(
      el("span", null, `ROOM ${Math.round(song.buses.reverb.return * 100)}%`),
      el("span", null, `ECHO ${Math.round(song.buses.delay.return * 100)}%`),
    );
    const openMixer = el("button", "daw-fbtn", "Open mixer");
    openMixer.type = "button";
    openMixer.addEventListener("click", () => toggleBottomPanel("mixer"));
    rvBody.appendChild(openMixer);
    rv.append(rvHead, rvBody);
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
      const lenB = Math.max(minLen(), snap(buf.duration * (song.bpm / 60)));
      const r = makeRegion(t, snap(startBeat), lenB, { name: file.name.replace(/\.[^.]+$/, ""), clipId });
      if (!stored) r.volatile = true;
      activeTrackId = t.id;
      sel = [{ trackId: t.id, regionId: r.id }];
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

  function importAudioFile(t, startBeat = null) {
    const input = document.createElement("input");
    input.type = "file"; input.accept = "audio/*";
    input.addEventListener("change", async () => {
      const f = input.files[0];
      if (!f) return;
      await importAudioBlob(t, f, startBeat == null ? engine.beatNow() : startBeat);
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
      const cueBeats = song.markers?.length
        ? song.markers.map((m) => m.beat)
        : song.tracks.flatMap((t) => t.regions.map((r) => r.start));
      const cues = [...new Set(cueBeats)].sort((a, b) => a - b)
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
          closeEditor();
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

  async function showRecoveryPicker() {
    let recoveries;
    try {
      recoveries = await listDawRecoveries("current");
    } catch {
      _toast("Recovery checkpoints are unavailable in this browser.", { severity: "error" });
      return;
    }
    if (!recoveries.length) {
      _toast("No previous save checkpoints yet.");
      return;
    }
    root.querySelector("#daw-recovery-dialog")?.remove();
    const dialog = el("dialog", "daw-recovery-dialog");
    dialog.id = "daw-recovery-dialog";
    const head = el("header", "daw-shortcut-head");
    const title = el("h2", null, "Recover previous save");
    const close = iconBtn("daw-hbtn", "×", "Close recovery");
    close.addEventListener("click", () => dialog.close());
    head.append(title, close);
    const intro = el("p", "daw-recovery-copy", "Choose a checkpoint. Your current song is preserved and the restore can be undone.");
    const list = el("div", "daw-recovery-list");
    for (const recovery of recoveries) {
      const row = el("button", "daw-recovery-item");
      row.type = "button";
      const date = new Date(recovery.savedAt);
      row.append(
        el("strong", null, Number.isNaN(date.getTime()) ? "Previous save" : date.toLocaleString()),
        el("span", null, recovery.reason || `Revision ${recovery.revision}`),
      );
      row.addEventListener("click", async () => {
        row.disabled = true;
        row.querySelector("span").textContent = "Restoring…";
        try {
          const restored = await restoreDawRecovery("current", recovery.id);
          const next = normalizeSong(restored?.data);
          if (!next) throw new Error("invalid recovery");
          if (Number.isInteger(restored.revision)) lastIdbRevision = restored.revision;
          pushState();
          closeEditor();
          song = next;
          selectedMarkerId = null;
          afterHistoryJump();
          dialog.close();
          _toast("Previous save restored — Ctrl+Z to undo.", { severity: "ok" });
        } catch {
          row.disabled = false;
          row.querySelector("span").textContent = "Could not restore this checkpoint";
          _toast("That recovery checkpoint could not be restored.", { severity: "error" });
        }
      });
      list.appendChild(row);
    }
    dialog.append(head, intro, list);
    dialog.addEventListener("close", () => dialog.remove(), { once: true });
    root.appendChild(dialog);
    if (typeof dialog.showModal === "function") dialog.showModal();
    else dialog.setAttribute("open", "");
  }

  function newSong() {
    pushState();
    song = defaultSong();
    const t = makeTrack("midi", { family: "chord" });
    song.tracks.push(t);
    activeTrackId = t.id;
    sel = [];
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
    // Drop clips no retained project revision references. Recovery documents
    // are restorable songs, so their audio must remain pinned too. If recovery
    // metadata cannot be read, skip GC rather than risk irreversible data loss.
    let canCollectGarbage = true;
    let recoveries = [];
    try {
      recoveries = await listDawRecoveries("current");
    } catch {
      canCollectGarbage = false;
    }
    const used = collectDawClipIds([song, ...recoveries]);
    if (canCollectGarbage) {
      for (const id of clips.keys()) {
        if (!used.has(id)) { clips.delete(id); deleteSample(id).catch(() => {}); }
      }
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

  function maxSongId(value) {
    let max = 0;
    const visit = (node) => {
      if (!node || typeof node !== "object") return;
      if (Number.isFinite(+node.id)) max = Math.max(max, +node.id);
      if (Array.isArray(node)) node.forEach(visit);
      else Object.values(node).forEach(visit);
    };
    visit(value);
    return max;
  }

  async function init(deps) {
    _getCtx = deps.getCtx;
    _toast = deps.toast || _toast;
    _onUse = deps.onUse || _onUse;
    _getSampler = deps.getSampler || _getSampler;
    root = document.getElementById("song-builder");
    root.replaceChildren(el("div", "daw-loading", "Loading Studio…"));

    const localRecord = readVersionedRecord(STORE_KEY, SCHEMA_V, MIGRATIONS);
    const localSong = normalizeSong(localRecord?.data);
    let idbRecord = null;
    try {
      idbRecord = await loadDawSong("current");
      lastIdbRevision = Number.isInteger(idbRecord?.revision) ? idbRecord.revision : 0;
    } catch {
      lastIdbRevision = null;
      saveState = "fallback";
    }
    const preferLocalFallback = !!localSong
      && shouldPreferDawFallback(localRecord?.metadata?.dawFallback, idbRecord);
    song = preferLocalFallback ? localSong : normalizeSong(idbRecord?.data);
    if (preferLocalFallback && idbRecord) {
      _toast("Recovered a newer local Studio save after browser storage failed.", { severity: "ok" });
    }
    if (!song && idbRecord) {
      try {
        const recoveries = await listDawRecoveries("current");
        for (const recovery of recoveries) {
          const candidate = normalizeSong(structuredClone(recovery.data));
          if (!candidate) continue;
          song = candidate;
          _toast("Recovered the newest valid Studio checkpoint.", { severity: "ok" });
          break;
        }
      } catch {}
    }
    if (!song) song = localSong;
    if (song) {
      idc = Math.max(1, maxSongId(song) + 1);
      activeTrackId = song.tracks[0]?.id ?? null;
    } else {
      const old = readVersioned("sxratch.song", 1, [(s) => s]);
      song = migrateOldSong(old);
      if (song) _toast("Imported your song-builder project into the new studio.", { severity: "ok" });
      else song = starterSong();
      normalizeSong(song);
    }
    if ((!idbRecord || preferLocalFallback) && song) {
      try {
        const savedRecord = await saveDawSong("current", SCHEMA_V, song, {
          reason: preferLocalFallback
            ? "local fallback recovery"
            : localSong
              ? "localStorage migration"
              : "initial song",
        });
        if (Number.isInteger(savedRecord?.revision)) lastIdbRevision = savedRecord.revision;
        // Clear an embedded failure marker only after IndexedDB contains this
        // exact document. If this local write fails, the newer IDB revision
        // still prevents the old marker from winning on the next boot.
        if (preferLocalFallback) writeVersioned(STORE_KEY, SCHEMA_V, song);
        saveState = "saved";
      } catch {
        saveState = "fallback";
      }
    }
    snapStep = nearestSnap(song.view?.snap);
    pxPerBeat = Math.max(6, Math.min(160, +song.view?.zoom || 26));
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
    await loadClips();

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("resize", applyPanels);
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "hidden" && _saveTimer) void persistSong("visibility");
    });
    window.addEventListener("pagehide", () => {
      if (_saveTimer) void persistSong("pagehide");
    });
    if (!rafId) rafLoop();

    // Debug handle (same convention as window.sxratch on the deck side) —
    // used by tests/automation, harmless in production.
    window.sxdaw = { get engine() { return engine; }, get song() { return song; }, get clips() { return clips; } };
    return true;
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

  function maybeStartTour() {
    const tour = ensureDawTour();
    if (tour.getState().status === "idle") requestAnimationFrame(() => tour.start());
  }

  return { init, stopPreview, midiNote, maybeStartTour, startTour: () => startDawTour(true) };
})();
