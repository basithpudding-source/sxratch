import { SampleBank, GM_PROGRAMS } from './instruments.js';
import { bufferToWav } from './wav.js';
import { readVersioned, writeVersioned } from './store.js';
import { createTapTempo } from './taptempo.js';
import { createMetronome } from './metronome.js';
import { saveSample, loadAllSamples } from './idb-store.js';
import { encodeMidi } from './midiexport.js';
import { themeColors, onThemeChange } from './theme.js';
import { playCol } from './pad-geometry.js';
import { buildGroove, GROOVE_FOR_TYPE } from './pad-grooves.js';
import {
  playInstrument, playDrumHit, makeReverbSend, makeEchoSend, makeChorus,
  glueCompressor, masterFinalize, stepRand,
  resolvePatch, factoryValue, ENGINE_SCHEMA, FACTORY_PATCHES, WAVES, FILTER_TYPES,
  noiseData, mulberry32, chokeSchedule,
} from './synth.js';

/* SongBuilder — a multi-track backing-track composer for the Vocal Studio.
 * STRUCTURE timeline of ordered sections → each section has its own key, time
 * signature, bar count, instruments, chords (any subdivision), a bass note-grid
 * and a full-kit drum sequencer. A per-section Play button auditions the section
 * with a live playhead (active chord + a cursor sweeping the bass/drum grids).
 * Renders to an AudioBuffer used as the Vocal Studio backing track. */
export const SongBuilder = (() => {
  const $ = sel => document.querySelector(sel);

  // Injected by init(): audio-context provider, toast, "use as backing" sink.
  let _getCtx = () => { throw new Error('SongBuilder not initialised'); };
  let _toast = () => {};
  let _onUse = () => {};
  let _getSampler = () => null; // returns the SXRATCH Sampler (for porting pad samples)

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const MAJOR = [0, 2, 4, 5, 7, 9, 11, 12];
  // Scale degrees (roots) + per-degree default diatonic quality.
  const DEGREES = [{ roman: 'I' }, { roman: 'ii' }, { roman: 'iii' }, { roman: 'IV' }, { roman: 'V' }, { roman: 'vi' }, { roman: 'vii' }];
  const DIATONIC_QUAL = ['maj', 'min', 'min', 'maj', 'maj', 'min', 'dim'];
  // Comprehensive but concise chord qualities (each a short menu entry).
  const QUALITIES = [
    { id: 'maj', label: 'Major', sfx: '' }, { id: 'min', label: 'Minor', sfx: 'm' },
    { id: 'dim', label: 'Diminished', sfx: 'dim' }, { id: 'aug', label: 'Augmented', sfx: 'aug' },
    { id: 'sus2', label: 'Sus2', sfx: 'sus2' }, { id: 'sus4', label: 'Sus4', sfx: 'sus4' },
    { id: '6', label: 'Sixth', sfx: '6' }, { id: 'm6', label: 'Minor 6th', sfx: 'm6' },
    { id: '7', label: 'Dominant 7th', sfx: '7' }, { id: 'maj7', label: 'Major 7th', sfx: 'maj7' },
    { id: 'm7', label: 'Minor 7th', sfx: 'm7' }, { id: 'm7b5', label: 'Half-dim (m7♭5)', sfx: 'm7♭5' },
    { id: 'dim7', label: 'Diminished 7th', sfx: 'dim7' }, { id: 'add9', label: 'Add9', sfx: 'add9' },
    { id: '9', label: 'Ninth', sfx: '9' }, { id: 'maj9', label: 'Major 9th', sfx: 'maj9' },
    { id: 'm9', label: 'Minor 9th', sfx: 'm9' },
  ];
  const QUAL_INTERVALS = {
    maj: [0, 4, 7], min: [0, 3, 7], dim: [0, 3, 6], aug: [0, 4, 8], sus2: [0, 2, 7], sus4: [0, 5, 7],
    '6': [0, 4, 7, 9], m6: [0, 3, 7, 9], '7': [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
    m7b5: [0, 3, 6, 10], dim7: [0, 3, 6, 9], add9: [0, 4, 7, 14], '9': [0, 4, 7, 10, 14], maj9: [0, 4, 7, 11, 14], m9: [0, 3, 7, 10, 14],
  };
  const INVERSIONS = [{ v: 0, label: 'Root pos.' }, { v: 1, label: '1st inv' }, { v: 2, label: '2nd inv' }, { v: 3, label: '3rd inv' }];
  // How long a chord sustains, as a fraction of its slot (Let ring overlaps into the next).
  const CHORD_LENGTHS = [{ v: 0.25, label: 'Staccato' }, { v: 0.5, label: 'Short' }, { v: 1, label: 'Full' }, { v: 1.8, label: 'Let ring' }];
  // Chord-builder keyboard range + key geometry (widths must match the CSS).
  const KBD_LO = 21, KBD_HI = 108;    // 88-key piano range: A0 to C8
  const KW = 34, KBW = 22;            // white / black key widths
  const BLACK_PCS = [1, 3, 6, 8, 10];
  const keyName = midi => NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);

  const SECTION_TYPES = ['Intro', 'Verse', 'Pre-Chorus', 'Chorus', 'Bridge', 'Outro'];
  // Default progressions as {degree, quality} per bar.
  const D = (d, q) => ({ d, q: q || DIATONIC_QUAL[d] });
  const SECTION_DEFAULTS = {
    'Intro': { bars: 4, chords: [D(0), D(4), D(5), D(3)] }, 'Verse': { bars: 4, chords: [D(5), D(3), D(0), D(4)] },
    'Pre-Chorus': { bars: 2, chords: [D(3), D(4)] }, 'Chorus': { bars: 4, chords: [D(0), D(4), D(5), D(3)] },
    'Bridge': { bars: 4, chords: [D(5), D(3), D(0), D(4, '7')] }, 'Outro': { bars: 4, chords: [D(0), D(3), D(0), D(0)] },
  };
  const TIME_SIGS = [
    { label: '4/4', num: 4, den: 4 }, { label: '3/4', num: 3, den: 4 }, { label: '2/4', num: 2, den: 4 },
    { label: '6/8', num: 6, den: 8 }, { label: '5/4', num: 5, den: 4 }, { label: '7/8', num: 7, den: 8 }, { label: '12/8', num: 12, den: 8 },
  ];
  const SUBDIVS = [{ label: '8th-note grid', v: 2 }, { label: '16th-note grid', v: 4 }, { label: 'Triplet grid', v: 3 }];
  const CHORD_RES = [{ label: 'Per bar', v: 1 }, { label: 'Per beat', v: 'beat' }, { label: 'Per ½ beat', v: 'half' }, { label: 'Per ¼ beat', v: 'quarter' }];
  const CHORD_SOUNDS = [
    { id: 'pad', label: 'Warm synth pad' }, { id: 'strings', label: 'String ensemble' },
    { id: 'epiano', label: 'Electric piano' }, { id: 'organ', label: 'Drawbar organ' }, { id: 'guitar', label: 'Acoustic guitar' },
  ];
  const BASS_SOUNDS = [
    { id: 'electric', label: 'Electric bass' }, { id: 'synth', label: 'Synth bass' },
    { id: 'upright', label: 'Upright (acoustic)' }, { id: 'sub', label: 'Sub sine' },
  ];
  const LEAD_SOUNDS = [
    { id: 'synth', label: 'Synth lead' }, { id: 'square', label: 'Square (chip)' },
    { id: 'flute', label: 'Flute' }, { id: 'bell', label: 'Bell' }, { id: 'guitar', label: 'Plucked guitar' },
  ];
  const DRUM_KITS = [
    { id: 'acoustic', label: 'Acoustic kit' }, { id: '808', label: '808 / Hip-hop' },
    { id: 'electronic', label: 'Electronic' }, { id: 'bossa', label: 'Bossa / Brushes' }, { id: 'lofi', label: 'Lo-Fi' },
  ];
  const DRUM_ROWS = [
    { key: 'crash', label: 'Crash' }, { key: 'hat', label: 'Hi-Hat' }, { key: 'open', label: 'Open Hat' },
    { key: 'snare', label: 'Snare' }, { key: 'tomH', label: 'Tom Hi' }, { key: 'tomM', label: 'Tom Mid' },
    { key: 'tomL', label: 'Tom Low' }, { key: 'kick', label: 'Kick' },
  ];
  // Drum step values: 0 off · 1 normal · 2 accent · 3 ghost (old saves used
  // booleans — `v === true ? 1 : v | 0` normalises everywhere they're read).
  const DRUM_VELS = { 1: 1, 2: 1.4, 3: 0.45 };
  const drumVal = (v) => (v === true ? 1 : v | 0);

  // Grid geometry (must match CSS): label col + gap, then fixed-width cells + gap.
  // (The playhead's pixel position used to be computed here from LABEL_W/
  // CELL_W/GAP constants that disagreed with the CSS grid — 52/20/3 against
  // 54/18/3 — so the cursor drifted ~2px per step, ~126px by step 63. The
  // position is now a COLUMN INDEX written to `--play-col`; CSS resolves it
  // with its own --lblw/--cell/--gap, so the two can no longer disagree.)

  const TL_SCALE = 14;       // px per second for the proportional timeline
  let idc = 0;
  let song = { bpm: 90, sections: [], selected: 0 };
  let loopSection = false;   // loop the per-section preview
  let countInOn = false;     // 1-bar click count-in before section play
  let padMetro = null;       // shared metronome instance (lazy)
  let playNodes = [];        // whole-song preview sources
  let sectionPlay = null;    // {src, startAt, dur, s, chordGrid, lastSlot, raf, loop}
  let sampleBank = null;     // sampled-instrument engine (lazy; opt-in)
  let useSamples = false;    // false = synth voices (default), true = sampled GM
  const renderCache = new Map(); // memoized offline renders, keyed by a song hash
  const TRACK_MIX_DEFAULTS = {
    chords: { volume: 0.82, pan: 0, tone: 0.68, echo: 0.08, reverb: 0.18, mute: false, solo: false },
    bass: { volume: 0.88, pan: -0.04, tone: 0.54, echo: 0.02, reverb: 0.04, mute: false, solo: false },
    lead: { volume: 0.78, pan: 0.08, tone: 0.72, echo: 0.16, reverb: 0.20, mute: false, solo: false },
    drums: { volume: 0.90, pan: 0, tone: 0.74, echo: 0.03, reverb: 0.08, mute: false, solo: false },
    sampler: { volume: 0.82, pan: 0, tone: 0.70, echo: 0.08, reverb: 0.10, mute: false, solo: false },
  };
  const TRACK_KEYS = Object.keys(TRACK_MIX_DEFAULTS);

  function cloneMixDefaults() {
    return Object.fromEntries(TRACK_KEYS.map(k => [k, { ...TRACK_MIX_DEFAULTS[k] }]));
  }

  function ensureMix(s) {
    if (!s) return cloneMixDefaults();
    if (!s.mix || typeof s.mix !== 'object') s.mix = {};
    TRACK_KEYS.forEach(k => {
      if (!s.mix[k] || typeof s.mix[k] !== 'object') s.mix[k] = { ...TRACK_MIX_DEFAULTS[k] };
      else Object.entries(TRACK_MIX_DEFAULTS[k]).forEach(([prop, val]) => {
        if (s.mix[k][prop] == null) s.mix[k][prop] = val;
      });
    });
    return s.mix;
  }

  function mixFor(s, key) {
    return ensureMix(s)[key] || TRACK_MIX_DEFAULTS[key] || TRACK_MIX_DEFAULTS.chords;
  }

  /* ---------------- model maths ---------------- */
  const stepsPerBar = s => s.ts.num * s.subdiv;
  const totalSteps = s => s.bars * stepsPerBar(s);
  // A section can override the song tempo (s.bpm); everything downstream —
  // durations, render scheduling, echo sync, timeline widths — derives from
  // these helpers, so the override flows everywhere automatically.
  const secPerQuarter = (s) => 60 / ((s && s.bpm) || song.bpm);
  const unitSec = s => (4 / s.ts.den) * secPerQuarter(s);
  const barSec = s => s.ts.num * unitSec(s);
  const stepSec = s => barSec(s) / stepsPerBar(s);
  const sectionSec = s => barSec(s) * s.bars;
  const totalSeconds = () => song.sections.reduce((t, s) => t + sectionSec(s), 0);
  const fmtTime = sec => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

  /** Fill a section with a musically conservative 4-chord progression. */
  function fillChords(s) {
    pushState();
    const d = SECTION_DEFAULTS[s.type] || SECTION_DEFAULTS.Verse;
    const spb = stepsPerBar(s);
    s.chords = new Array(totalSteps(s)).fill(null);
    d.chords.slice(0, s.bars).forEach((c, b) => {
      if (b * spb < s.chords.length) s.chords[b * spb] = makeChordObj(degreeChordNotes(c.d, c.q, s.key), spb);
    });
    renderEditor(); saveSong();
    _toast('Added a chord progression — Ctrl+Z to undo.');
  }

  /** Fill a section with the groove its type calls for. */
  function fillGroove(s) {
    pushState();
    s.drums = seedDrums(s);
    renderEditor(); saveSong();
    _toast('Added a beat — Ctrl+Z to undo.');
  }

  function seedDrums(s) {
    // Grooves vary by section type: six sections used to open with six
    // identical beats, which read as "the tool only does one thing".
    return buildGroove(GROOVE_FOR_TYPE[s.type] || 'backbeat', {
      bars: s.bars, beatsPerBar: s.ts.num, subdiv: s.subdiv,
    });
  }

  // A chord slot is null (rest) or { d:degree 0-6, q:qualityId, inv:0-3 }.
  function chordIntervals(ch) {
    const ivs = (QUAL_INTERVALS[ch.q] || QUAL_INTERVALS.maj).slice();
    const inv = Math.min(ch.inv || 0, ivs.length - 1);
    for (let i = 0; i < inv; i++) ivs.push(ivs.shift() + 12);
    return ivs;
  }
  function chordMidi(ch, key) { const base = 60 + key + MAJOR[ch.d]; return chordIntervals(ch).map(x => base + x); }
  function chordFullName(ch, key) {
    if (!ch) return '—';
    const name = NOTE_NAMES[(key + MAJOR[ch.d]) % 12] + (QUALITIES.find(q => q.id === ch.q) || {}).sfx;
    const inv = Math.min(ch.inv || 0, (QUAL_INTERVALS[ch.q] || []).length - 1);
    if (inv > 0) { const bass = NOTE_NAMES[(key + MAJOR[ch.d] + chordIntervals(ch)[0]) % 12]; return name + '/' + bass; }
    return name;
  }
  const bassRowName = (row, key) => NOTE_NAMES[(key + MAJOR[row]) % 12];

  /* ---- note-set chord model ---- A chord is { notes:[midi…], len:steps, name, root:pc }.
   * Recognise a chord name from any set of notes by matching pitch-class intervals. */
  function analyzeChord(notes) {
    if (!notes || !notes.length) return { name: '—', root: 0 };
    const sorted = [...notes].sort((a, b) => a - b);
    const bassPc = sorted[0] % 12;
    const pcs = [...new Set(sorted.map(n => n % 12))];
    for (const root of pcs) {
      const sig = pcs.map(p => (p - root + 12) % 12).sort((a, b) => a - b).join(',');
      for (const q of QUALITIES) {
        const qsig = [...new Set(QUAL_INTERVALS[q.id].map(x => x % 12))].sort((a, b) => a - b).join(',');
        if (qsig === sig) {
          let name = NOTE_NAMES[root] + q.sfx;
          if (bassPc !== root) name += '/' + NOTE_NAMES[bassPc];
          return { name, root };
        }
      }
    }
    if (pcs.length === 1) return { name: NOTE_NAMES[pcs[0]], root: pcs[0] };
    return { name: sorted.map(n => NOTE_NAMES[n % 12]).join(' '), root: bassPc };
  }
  const nameChord = notes => analyzeChord(notes).name;
  function makeChordObj(notes, len) {
    const sorted = [...notes].sort((a, b) => a - b);
    const a = analyzeChord(sorted);
    return { notes: sorted, len: Math.max(1, len), name: a.name, root: a.root };
  }
  // Notes (midi) for a diatonic degree+quality — used to seed default progressions.
  const degreeChordNotes = (d, q, key) => (QUAL_INTERVALS[q] || QUAL_INTERVALS.maj).map(x => 60 + key + MAJOR[d] + x);
  // Step coverage for the single-row chord grid: null | {start, startStep, name}.
  function chordCoverage(s, cols) {
    const cov = new Array(cols).fill(null);
    for (let i = 0; i < cols; i++) { const ch = s.chords[i]; if (ch) for (let k = 0; k < ch.len && i + k < cols; k++) if (!cov[i + k]) cov[i + k] = { start: k === 0, startStep: i, name: ch.name }; }
    return cov;
  }
  // The start step of the chord covering `step`, or null.
  function chordStartCovering(s, step) {
    for (let i = step; i >= 0; i--) { const ch = s.chords[i]; if (ch) return (i + ch.len > step) ? i : null; }
    return null;
  }
  // Map a root pitch-class to the nearest bass grid row (diatonic degrees of the key).
  function nearestBassRow(pc, key) {
    let best = 0, bestD = 99;
    for (let r = 0; r < MAJOR.length; r++) {
      const rpc = (key + MAJOR[r]) % 12;
      let d = Math.abs(rpc - ((pc % 12) + 12) % 12); d = Math.min(d, 12 - d);
      if (d < bestD) { bestD = d; best = r; }
    }
    return best;
  }

  // Bass/lead notes: array per step of null | { r: rowIndex, len: stepsCount } (note start; covered steps stay null).
  function autofillBass(s) {
    const tot = totalSteps(s);
    s.bass = new Array(tot).fill(null);
    for (let i = 0; i < tot; i++) {
      const ch = s.chords[i]; if (!ch) continue;
      s.bass[i] = { r: nearestBassRow(ch.root, s.key), len: Math.min(ch.len, tot - i) }; // follow each chord's root
    }
  }
  function makeSection(type, tmpl) {
    const d = SECTION_DEFAULTS[type] || { bars: 4, chords: [D(0)] };
    const s = {
      id: ++idc, type,
      name: type,
      key: tmpl ? tmpl.key : 0,
      chordSound: tmpl ? tmpl.chordSound : 'pad',
      bassSound: tmpl ? tmpl.bassSound : 'electric',
      leadSound: tmpl ? tmpl.leadSound : 'synth',
      drumKit: tmpl ? tmpl.drumKit : 'acoustic',
      ts: tmpl ? { num: tmpl.ts.num, den: tmpl.ts.den } : { num: 4, den: 4 },
      subdiv: tmpl ? tmpl.subdiv : 4,
      swing: tmpl ? (tmpl.swing || 0) : 0,
      bars: d.bars, chords: [], drums: {}, bass: [], lead: [], samplerRows: [], mix: cloneMixDefaults(),
    };
    // Seed the default progression as note-set chords, one per bar on the step grid.
    s.chords = new Array(totalSteps(s)).fill(null);
    const spb0 = stepsPerBar(s);
    d.chords.slice(0, s.bars).forEach((c, b) => { s.chords[b * spb0] = makeChordObj(degreeChordNotes(c.d, c.q, s.key), spb0); });
    s.drums = seedDrums(s);
    autofillBass(s);
    s.lead = new Array(totalSteps(s)).fill(null); // lead melody starts empty (optional)
    return s;
  }
  function reflow(s) {
    ensureMix(s);
    if (s.swing == null) s.swing = 0;
    const ts = totalSteps(s);
    const oc = s.chords || [];
    s.chords = Array.from({ length: ts }, (_, i) => { const ch = oc[i]; return ch ? { ...ch, len: Math.min(ch.len, ts - i) } : null; });
    const nd = {}; DRUM_ROWS.forEach(r => { const old = s.drums[r.key] || []; nd[r.key] = Array.from({ length: ts }, (_, i) => drumVal(old[i])); });
    s.drums = nd;
    const ob = s.bass || []; s.bass = Array.from({ length: ts }, (_, i) => { const n = ob[i]; return n ? { r: n.r, len: Math.min(n.len, ts - i) } : null; });
    const ol = s.lead || []; s.lead = Array.from({ length: ts }, (_, i) => { const n = ol[i]; return n ? { r: n.r, len: Math.min(n.len, ts - i) } : null; });
    (s.samplerRows || []).forEach(row => {
      const op = row.placements || [];
      row.placements = Array.from({ length: ts }, (_, i) => { const n = op[i]; return n ? { len: Math.min(n.len, ts - i) } : null; });
    });
  }

  /* ---------------- UI ---------------- */
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function opt(value, label, sel) { const o = el('option', null, label); o.value = value; if (sel) o.selected = true; return o; }
  function labelWrap(text, control) { const l = el('label', null, text); l.appendChild(control); return l; }
  const cellMarks = (c, sub, spb) => (c % spb === 0 ? ' bar' : (c % sub === 0 ? ' beat' : ''));

  const PAD_MODES = [
    { key: 'chords', label: 'CHORDS', icon: '▰▰▰' },
    { key: 'bass', label: 'BASS', icon: '♩' },
    { key: 'lead', label: 'LEAD', icon: '⌁' },
    { key: 'drums', label: 'DRUMS', icon: '▦' },
    { key: 'sampler', label: 'SAMPLE', icon: '◫' },
  ];
  let activePadMode = 'chords';
  let chordQual = 'auto';        // palette quality: 'auto' = diatonic for the degree
  let chordRes = 1;              // default placement length, in bars-worth of steps
  let previewedOnce = false;     // has the user heard the whole song yet?
  let openSynthAdvanced = false; // the inspector's Advanced disclosure, remembered
  let noteCursor = { bass: { row: 0, col: 0 }, lead: { row: 0, col: 0 } };
  let drumCursor = { key: 'kick', col: 0 };

  function setActivePadMode(mode, rerender = true) {
    if (activePadMode === mode && rerender) return;
    activePadMode = PAD_MODES.some(m => m.key === mode) ? mode : 'chords';
    if (!rerender) return;
    // On the bench, switching instrument genuinely swaps what is on screen:
    // the grid, its tools, the dock body and the inspector's subject all
    // change together. The keybed itself is preserved by renderEditor.
    const s = song.sections[song.selected];
    if (!s) { renderEditor(); return; }
    renderEditor();
  }

  /**
   * Rebuild the focused lane's grid in place (scroll preserved).
   * Only the focused lane is mounted now, so a request for any other lane is
   * a no-op on the grid — its instrument-rail thumbnail is repainted instead.
   */
  function refreshLaneGrid(s, kind) {
    if (kind !== activePadMode) {
      const mini = document.querySelector(`.inst-tab[data-lane="${kind}"] .inst-mini`);
      if (mini) drawLaneMini(mini, s, kind);
      return;
    }
    const bench = document.querySelector('.bench');
    const old = bench && bench.querySelector('.seq-grid');
    if (!old) { renderEditor(); return; }
    const fresh = kind === 'drums' ? buildDrumGrid(s) : buildNoteGrid(s, kind);
    const sl = old.scrollLeft;
    old.replaceWith(fresh);
    fresh.scrollLeft = sl;
    const mini = document.querySelector(`.inst-tab[data-lane="${kind}"] .inst-mini`);
    if (mini) drawLaneMini(mini, s, kind);
  }

  let undoStack = [];
  let redoStack = [];
  let undoBytes = 0;
  // Budget the history by BYTES, not entries. A 16-section song serialises to
  // several hundred KB, so a flat count of 30 could pin tens of MB — while on
  // a two-section sketch it throws away far more history than it needs to.
  const UNDO_BYTE_BUDGET = 8 * 1024 * 1024;

  function pushState() {
    const snap = JSON.stringify(song);
    undoStack.push(snap);
    undoBytes += snap.length;
    while (undoStack.length > 1 && undoBytes > UNDO_BYTE_BUDGET) undoBytes -= undoStack.shift().length;
    redoStack = []; // clear redo on new action
    updateUndoRedoButtons();
  }

  /** Discard the most recent pushState() without applying it. */
  function dropState() {
    const snap = undoStack.pop();
    if (snap != null) undoBytes -= snap.length;
    updateUndoRedoButtons();
  }

  /**
   * One undo entry per POINTER GESTURE, not per cell. A drag across 32 steps
   * fires the handler 32 times; without this, undoing a single stroke takes
   * 32 presses. beginGesture() snapshots once; endGesture() throws the
   * snapshot away again if the gesture turned out to change nothing (a tap on
   * an empty cell with no chord built, say).
   */
  function beginGesture() { pushState(); }
  function endGesture() {
    if (undoStack.length && undoStack[undoStack.length - 1] === JSON.stringify(song)) dropState();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(song));
    const previous = undoStack.pop();
    undoBytes -= previous.length;
    song = JSON.parse(previous);
    idc = Math.max(0, ...song.sections.map(s => s.id || 0));
    const bpmSlider = $('#song-bpm');
    if (bpmSlider) {
      bpmSlider.value = song.bpm || 90;
      const bpmVal = $('#song-bpm-v');
      if (bpmVal) bpmVal.textContent = song.bpm || 90;
    }
    const humSel = $('#song-humanize');
    if (humSel) humSel.value = String(song.humanize || 0);
    render();
  }

  function redo() {
    if (!redoStack.length) return;
    const snap = JSON.stringify(song);
    undoStack.push(snap);
    undoBytes += snap.length;
    const next = redoStack.pop();
    song = JSON.parse(next);
    idc = Math.max(0, ...song.sections.map(s => s.id || 0));
    const bpmSlider = $('#song-bpm');
    if (bpmSlider) {
      bpmSlider.value = song.bpm || 90;
      const bpmVal = $('#song-bpm-v');
      if (bpmVal) bpmVal.textContent = song.bpm || 90;
    }
    const humSel = $('#song-humanize');
    if (humSel) humSel.value = String(song.humanize || 0);
    render();
  }

  function updateUndoRedoButtons() {
    const undoBtn = $('#btn-song-undo');
    const redoBtn = $('#btn-song-redo');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  // Persisted-song schema version + upgrade steps (legacy raw saves are v0;
  // the shape is unchanged today, so v0 → v1 is an identity migration).
  const SONG_SCHEMA_V = 1;
  const SONG_MIGRATIONS = [(s) => s];

  let _saveTimer = null, _quotaToastAt = 0;
  function writeSong() {
    writeVersioned("sxratch.song", SONG_SCHEMA_V, song, {
      onQuota: (e) => {
        console.error("Auto-save failed", e);
        // Throttled: a grid drag calls saveSong per cell — one warning per 30 s.
        if (Date.now() - _quotaToastAt > 30000) {
          _quotaToastAt = Date.now();
          _toast("Browser storage is full — your edits are NOT being auto-saved.");
        }
      },
    });
  }
  // Debounced auto-save: a fast drag across the grid fires saveSong() per cell;
  // coalesce those into one serialize+write (button state stays instant).
  function saveSong() {
    if (_saveTimer) clearTimeout(_saveTimer);
    _saveTimer = setTimeout(() => { _saveTimer = null; writeSong(); }, 400);
    updateUndoRedoButtons();
  }
  // Flush immediately (e.g. when the tab is hidden/closed) so no edit is lost.
  function flushSong() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    writeSong();
  }

  function render() {
    stopSectionPlay(); stopPreview();
    renderStructure();
    renderEditor();
    const has = song.sections.length > 0;
    ['#btn-song-preview', '#btn-song-deckA', '#btn-song-deckB', '#btn-song-dl', '#btn-song-export', '#btn-song-midi'].forEach(sel => { const b = $(sel); if (b) b.disabled = !has; });
    $('#song-duration').textContent = has ? `${totalSeconds().toFixed(1)}s · ${song.sections.length} sections` : '';
    saveSong();
  }

  function renderStructure() {
    const wrap = $('#song-structure');
    wrap.innerHTML = '';
    if (!song.sections.length) { wrap.appendChild(el('p', 'hint', 'Add sections above — they\'ll line up here as your arrangement.')); return; }
    let cum = 0;
    song.sections.forEach((s, i) => {
      const secs = sectionSec(s);
      const chip = el('div', 'song-chip' + (i === song.selected ? ' active' : ''));
      chip.style.width = Math.max(132, secs * TL_SCALE) + 'px';   // width ∝ duration
      chip.title = `${s.type} — ${secs.toFixed(1)}s`;
      // top row: move controls + actions
      const top = el('div', 'song-chip-top');
      const move = el('div', 'song-chip-move');
      const left = el('button', 'song-chip-btn', '◀'); left.disabled = i === 0; left.title = 'Move left';
      const right = el('button', 'song-chip-btn', '▶'); right.disabled = i === song.sections.length - 1; right.title = 'Move right';
      left.addEventListener('click', e => { e.stopPropagation(); moveSection(i, -1); });
      right.addEventListener('click', e => { e.stopPropagation(); moveSection(i, 1); });
      move.append(left, right);
      const acts = el('div', 'song-chip-acts');
      const dup = el('button', 'song-chip-btn2', '⧉'); dup.title = 'Duplicate section';
      dup.addEventListener('click', e => { e.stopPropagation(); duplicateSection(i); });
      const del = el('button', 'song-chip-btn2 song-chip-x', '×'); del.title = 'Remove section';
      del.addEventListener('click', e => { e.stopPropagation(); removeSection(i); });
      acts.append(dup, del);
      top.append(move, acts);
      // label
      const label = el('div', 'song-chip-label');
      label.append(el('span', 'song-chip-type', s.name || s.type), el('span', 'song-chip-bars', `${s.bars} bars · ${s.ts.num}/${s.ts.den} · ${NOTE_NAMES[s.key]}`));
      if (s.bpm) label.appendChild(el('span', 'song-chip-bpm', `♩ ${s.bpm}`));
      // Per-lane content dots. This is where the inspector's six fake "meters"
      // went: as a flat mark per lane on each chip they answer a real question
      // — "which section has no drums?" — instead of dressing note density up
      // as a signal level.
      const cols = totalSteps(s) || 1;
      const dots = el('div', 'chip-dots');
      const fill = {
        chords: s.chords.filter(Boolean).length / cols,
        bass: (s.bass || []).filter(Boolean).length / cols,
        lead: (s.lead || []).filter(Boolean).length / cols,
        drums: DRUM_ROWS.reduce((n, r) => n + (s.drums[r.key] || []).filter(drumVal).length, 0) / (cols * DRUM_ROWS.length),
        sampler: (s.samplerRows || []).reduce((n, r) => n + (r.placements || []).filter(Boolean).length, 0) / cols,
      };
      PAD_MODES.forEach(m => {
        const dot = el('i', 'chip-dot chip-dot-' + m.key + (fill[m.key] > 0.001 ? ' on' : ''));
        dot.title = `${m.label}: ${fill[m.key] > 0.001 ? Math.round(fill[m.key] * 100) + '% of steps' : 'empty'}`;
        dots.appendChild(dot);
      });
      label.appendChild(dots);
      // time marker (cumulative start)
      const time = el('div', 'song-chip-time', fmtTime(cum));
      chip.append(top, label, time);
      chip.addEventListener('click', () => { song.selected = i; render(); });
      wrap.appendChild(chip);
      cum += secs;
    });
    // end-of-song total marker
    const end = el('div', 'song-tl-end');
    end.append(el('span', 'song-tl-flag', '▏'), el('span', 'song-tl-total', fmtTime(cum)));
    wrap.appendChild(end);
  }

  /* ============================ THE BENCH ==================================
   * You edit exactly ONE instrument at a time and it gets the whole centre
   * column; the other four compress into a five-tab instrument rail. The old
   * layout stacked all five lanes at once, which at 1280x800 left the lane
   * stack 84px tall for 138px of content — the drum lane rendered 18px high
   * with 47px of overflow, i.e. unusable, while the keyboard dock below it
   * took 284px.
   *
   * Scope rule, so this cannot re-accumulate:
   *   per-song            → .pad-transport only
   *   per-section         → .section-strip / .section-sheet only
   *   per-section-per-track → .pad-inspector only
   *   per-lane editing    → .bench-tools only
   * No control appears in two of them.
   * ======================================================================= */

  let _dockEl = null;      // built once; renderEditor re-parents rather than rebuilds

  function renderEditor() {
    const ed = $('#song-editor');
    if (!song.sections.length) {
      ed.replaceChildren();
      ed.classList.add('hidden');
      renderInspector(null);
      renderNextStep();
      return;
    }
    ed.classList.remove('hidden');
    song.selected = Math.max(0, Math.min(song.selected, song.sections.length - 1));
    const s = song.sections[song.selected];
    ensureMix(s);

    // The dock owns ~140 key buttons. Rebuilding it per edit was the main
    // source of per-note jank, so it is created once and moved, never remade.
    if (!_dockEl) _dockEl = buildSharedKeyboardDock(s);
    const dockHost = el('div', 'pad-dock');
    dockHost.appendChild(_dockEl);

    ed.replaceChildren(
      buildSectionStrip(s),
      buildInstrumentRail(s),
      buildBenchRuler(s),
      buildBench(s),
      dockHost
    );
    refreshSharedKeyboard(s);
    renderInspector(s);
    renderNextStep();
  }

  /* ---- 1. section strip: the per-section settings you touch while writing --- */
  function buildSectionStrip(s) {
    const strip = el('div', 'section-strip');

    const dot = el('span', 'strip-dot');
    dot.style.background = 'var(--lane, var(--sx-lane-chords))';

    const nameIn = el('input'); nameIn.type = 'text'; nameIn.value = s.name || s.type;
    nameIn.className = 'section-name-input';
    nameIn.setAttribute('aria-label', 'Section name');
    nameIn.addEventListener('change', () => {
      pushState();
      s.name = nameIn.value.trim() || s.type;
      renderStructure(); saveSong();
    });

    const field = (label, control, cls = '') => {
      const l = el('label', 'strip-field ' + cls);
      l.append(el('span', 'strip-label', label), control);
      return l;
    };

    const keySel = el('select'); NOTE_NAMES.forEach((n, i) => keySel.appendChild(opt(i, n, i === s.key)));
    keySel.addEventListener('change', () => { pushState(); s.key = +keySel.value; renderEditor(); renderStructure(); saveSong(); });

    const barsIn = el('input'); barsIn.type = 'number'; barsIn.min = 1; barsIn.max = 64; barsIn.value = s.bars;
    barsIn.className = 'bars-input';
    barsIn.addEventListener('change', () => { pushState(); s.bars = Math.max(1, Math.min(64, parseInt(barsIn.value, 10) || 1)); reflow(s); render(); });

    const tsSel = el('select'); TIME_SIGS.forEach(t => tsSel.appendChild(opt(t.label, t.label, t.num === s.ts.num && t.den === s.ts.den)));
    tsSel.addEventListener('change', () => { pushState(); const t = TIME_SIGS.find(x => x.label === tsSel.value); s.ts = { num: t.num, den: t.den }; reflow(s); render(); });

    // Swing stays INLINE, not behind the sheet: it is a live drag whose effect
    // you judge by ear while the section loops, so a popover over the grid
    // would occlude the thing you are listening to.
    const swingWrap = el('div', 'strip-swing');
    const swingVal = el('span', 'swing-readout', Math.round((s.swing || 0) * 100) + '%');
    const swingIn = el('input');
    swingIn.type = 'range'; swingIn.min = 0; swingIn.max = 0.45; swingIn.step = 0.01;
    swingIn.value = s.swing || 0;
    swingIn.title = 'Swing — delays every 2nd step (≈33% is a triplet feel)';
    swingIn.setAttribute('aria-label', 'Swing');
    let swingEdit = false;
    const beginSwing = () => { if (!swingEdit) { pushState(); swingEdit = true; } };
    swingIn.addEventListener('pointerdown', beginSwing);
    swingIn.addEventListener('keydown', beginSwing);
    swingIn.addEventListener('change', () => { swingEdit = false; });
    swingIn.addEventListener('input', () => {
      s.swing = +swingIn.value;
      swingVal.textContent = Math.round(s.swing * 100) + '%';
      swingIn.setAttribute('aria-valuetext', swingVal.textContent);
      renderCache.clear();
      saveSong();
    });
    swingWrap.append(el('span', 'strip-label', 'Swing'), swingIn, swingVal);

    const playBtn = el('button', 'btn btn-primary strip-play', '▶ Play section');
    playBtn.id = 'btn-song-play-sec';
    playBtn.addEventListener('click', toggleSectionPlay);

    const toggle = (glyph, title, checked, onChange) => {
      const b = el('button', 'strip-toggle' + (checked ? ' active' : ''), glyph);
      b.type = 'button'; b.title = title;
      b.setAttribute('aria-pressed', checked ? 'true' : 'false');
      b.addEventListener('click', () => {
        const next = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', next ? 'true' : 'false');
        b.classList.toggle('active', next);
        onChange(next);
      });
      return b;
    };
    const loopBtn = toggle('🔁', 'Loop the section while it plays', loopSection, (on) => {
      loopSection = on;
      if (sectionPlay) {
        sectionPlay.loop = on; sectionPlay.src.loop = on;
        if (on) { sectionPlay.src.loopStart = 0; sectionPlay.src.loopEnd = sectionPlay.dur; }
      }
    });
    const countBtn = toggle('♩', 'One bar of clicks before the section starts', countInOn, (on) => { countInOn = on; });

    const moreBtn = el('button', 'strip-more', '⋯');
    moreBtn.type = 'button';
    moreBtn.title = 'Section type, step grid, section tempo, delete';
    moreBtn.setAttribute('aria-label', 'More section settings');
    moreBtn.addEventListener('click', () => openSectionSheet(s));

    strip.append(dot, nameIn,
      field('Key', keySel), field('Bars', barsIn), field('Time', tsSel),
      swingWrap, playBtn, loopBtn, countBtn, moreBtn);
    return strip;
  }

  /** Settings you set once per section and then stop thinking about. */
  function openSectionSheet(s) {
    let dlg = $('#section-sheet');
    if (!dlg) {
      dlg = el('div', 'dialog');           // .dialog → app.js's focus trap + Esc applies
      dlg.id = 'section-sheet';
      document.body.appendChild(dlg);
    }
    const card = el('div', 'dialog-card');
    card.append(el('h3', null, `${s.name || s.type} — section settings`));

    const row = (label, control, hint) => {
      const l = el('label', 'sheet-row');
      l.append(el('span', null, label), control);
      if (hint) l.appendChild(el('span', 'hint', hint));
      card.appendChild(l);
    };

    const typeSel = el('select'); SECTION_TYPES.forEach(t => typeSel.appendChild(opt(t, t, t === s.type)));
    typeSel.addEventListener('change', () => {
      pushState(); s.type = typeSel.value;
      if (!s.name || SECTION_TYPES.includes(s.name)) s.name = s.type;
      render(); saveSong();
    });
    row('Section type', typeSel);

    const subSel = el('select'); SUBDIVS.forEach(d => subSel.appendChild(opt(d.v, d.label, d.v === s.subdiv)));
    subSel.addEventListener('change', () => { pushState(); s.subdiv = +subSel.value; reflow(s); render(); });
    row('Step grid', subSel);

    // Explicit override + a toast on a rejected value, instead of the silent
    // revert the old inline field did.
    const bpmWrap = el('span', 'sheet-bpm');
    const bpmOn = el('input'); bpmOn.type = 'checkbox'; bpmOn.checked = !!s.bpm;
    const bpmIn = el('input'); bpmIn.type = 'number'; bpmIn.min = 50; bpmIn.max = 180;
    bpmIn.className = 'bars-input'; bpmIn.value = s.bpm || song.bpm; bpmIn.disabled = !s.bpm;
    bpmOn.addEventListener('change', () => {
      pushState();
      bpmIn.disabled = !bpmOn.checked;
      if (bpmOn.checked) s.bpm = Math.max(50, Math.min(180, parseInt(bpmIn.value, 10) || song.bpm));
      else delete s.bpm;
      render();
    });
    bpmIn.addEventListener('change', () => {
      const v = parseInt(bpmIn.value, 10);
      if (!(v >= 50 && v <= 180)) { _toast('Section tempo must be 50–180 BPM.'); bpmIn.value = s.bpm || song.bpm; return; }
      pushState(); s.bpm = v; render();
    });
    bpmWrap.append(bpmOn, bpmIn);
    row('Section tempo', bpmWrap, `Off = follows the song (${song.bpm} BPM)`);

    const actions = el('div', 'dialog-actions');
    const del = el('button', 'btn btn-danger', 'Delete section');
    let armed = false;
    del.addEventListener('click', () => {
      if (!armed) { armed = true; del.textContent = 'Delete — sure?'; del.classList.add('confirm'); return; }
      dlg.hidden = true;
      removeSection(song.selected);
      _toast('Section deleted — Ctrl+Z to undo.');
    });
    const close = el('button', 'btn primary', 'Done');
    close.addEventListener('click', () => { dlg.hidden = true; });
    actions.append(del, close);
    card.appendChild(actions);

    dlg.replaceChildren(card);
    dlg.hidden = false;
    close.focus();
  }

  /* ---- 2. instrument rail: the ONE place a lane is named and chosen ------- */
  function buildInstrumentRail(s) {
    const rail = el('div', 'inst-rail');
    rail.setAttribute('role', 'tablist');
    rail.setAttribute('aria-label', 'Instrument');
    PAD_MODES.forEach(m => {
      const active = activePadMode === m.key;
      const tab = el('button', `inst-tab inst-${m.key}` + (active ? ' active' : ''));
      tab.type = 'button';
      tab.dataset.lane = m.key;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', active ? 'true' : 'false');
      tab.tabIndex = active ? 0 : -1;      // roving tabindex
      tab.append(el('span', 'inst-name', m.label));
      tab.append(el('span', 'inst-sound', modeSoundName(s, m.key)));
      const mix = mixFor(s, m.key === 'sampler' ? 'sampler' : m.key);
      const flags = el('span', 'inst-flags');
      if (mix.mute) flags.appendChild(el('i', 'inst-flag mute', 'M'));
      if (mix.solo) flags.appendChild(el('i', 'inst-flag solo', 'S'));
      tab.appendChild(flags);
      const mini = el('canvas', 'inst-mini');
      tab.appendChild(mini);
      tab.addEventListener('click', () => setActivePadMode(m.key));
      tab.addEventListener('keydown', e => {
        const i = PAD_MODES.findIndex(x => x.key === activePadMode);
        if (e.key === 'ArrowRight') { e.preventDefault(); setActivePadMode(PAD_MODES[(i + 1) % PAD_MODES.length].key); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); setActivePadMode(PAD_MODES[(i + PAD_MODES.length - 1) % PAD_MODES.length].key); }
      });
      rail.appendChild(tab);
      drawLaneMini(mini, s, m.key);
    });
    return rail;
  }

  /** A whole-section thumbnail of one lane — the other four stay legible. */
  function drawLaneMini(canvas, s, kind) {
    if (!canvas) return;
    const w = Math.max(40, canvas.clientWidth || 110), h = Math.max(10, canvas.clientHeight || 16);
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    const cols = totalSteps(s);
    if (!cols) return;
    const cw = w / cols;
    g.fillStyle = getComputedStyle(canvas).color;
    const mark = (c, span, top, height) => g.fillRect(c * cw, top, Math.max(1, span * cw - 0.5), height);
    if (kind === 'chords') {
      s.chords.forEach((ch, c) => { if (ch) mark(c, ch.len, h * 0.25, h * 0.5); });
    } else if (kind === 'bass' || kind === 'lead') {
      (s[kind] || []).forEach((n, c) => { if (n) mark(c, n.len, (1 - n.r / 8) * (h - 3), 3); });
    } else if (kind === 'drums') {
      DRUM_ROWS.forEach((r, ri) => (s.drums[r.key] || []).forEach((v, c) => {
        if (drumVal(v)) mark(c, 1, (ri / DRUM_ROWS.length) * h, Math.max(1, h / DRUM_ROWS.length - 0.5));
      }));
    } else {
      (s.samplerRows || []).forEach((row, ri) => (row.placements || []).forEach((n, c) => {
        if (n) mark(c, n.len || 1, (ri % 4) * (h / 4), Math.max(1, h / 4 - 0.5));
      }));
    }
  }

  /* ---- 3. ruler: where you are, and what is sounding --------------------- */
  function buildBenchRuler(s) {
    const ruler = el('div', 'bench-ruler');
    const left = el('div', 'ruler-left');
    left.append(el('span', 'ruler-stat', `${s.bars} bars`), el('span', 'ruler-stat', `${totalSteps(s)} steps`),
      el('span', 'ruler-stat', `${NOTE_NAMES[s.key]} major`));
    // The playing chord name now lives on the ruler, so it is visible on EVERY
    // lane — it used to sit inside the chord grid, i.e. invisible four times
    // out of five once only one lane is mounted.
    const nowName = el('div', 'chord-now');
    nowName.id = 'bench-chord-now';
    ruler.append(left, nowName);
    return ruler;
  }

  /* ---- 4. the bench: one lane, full size -------------------------------- */
  function buildBench(s) {
    const bench = el('div', 'bench bench-' + activePadMode);
    bench.dataset.lane = activePadMode;
    bench.append(buildLaneTools(s, activePadMode));

    if (activePadMode === 'chords') {
      const body = el('div'); body.id = 'chord-lane-body';
      body.appendChild(buildChordRow(s));
      bench.append(body, buildChordPalette(s));
    } else if (activePadMode === 'bass' || activePadMode === 'lead') {
      bench.appendChild(buildNoteGrid(s, activePadMode));
    } else if (activePadMode === 'drums') {
      bench.appendChild(buildDrumGrid(s));
    } else {
      s.samplerRows = s.samplerRows || [];
      bench.append(buildSamplerGrid(s), buildSamplerConfig(s));
    }
    return bench;
  }

  /**
   * Every lane action, in exactly one place. These used to exist twice — once
   * as a `.lane-tools` row and again in the inspector — so "Clear bass" had
   * two homes and the inspector copy was the only one that survived on
   * mobile.
   */
  function buildLaneTools(s, kind) {
    const tools = el('div', 'bench-tools');
    const act = (label, fn, cls = '') => {
      const b = el('button', 'btn btn-mini ' + cls, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      tools.appendChild(b);
      return b;
    };
    const clearLane = (label, apply) => act(label, () => {
      pushState(); apply(); renderEditor(); saveSong();
      _toast('Cleared — Ctrl+Z to undo.');
    }, 'btn-danger');

    if (kind === 'chords') {
      act('Clear built chord', () => { builtNotes = []; refreshChords(s); });
      clearLane('Clear chords', () => { s.chords = new Array(totalSteps(s)).fill(null); chordSelStep = null; builtNotes = []; });
    } else if (kind === 'bass') {
      act('Follow the chords', () => { pushState(); autofillBass(s); renderEditor(); saveSong(); });
      clearLane('Clear bass', () => { s.bass = new Array(totalSteps(s)).fill(null); });
    } else if (kind === 'lead') {
      clearLane('Clear lead', () => { s.lead = new Array(totalSteps(s)).fill(null); });
    } else if (kind === 'drums') {
      act('Clear this step', () => {
        pushState(); DRUM_ROWS.forEach(r => s.drums[r.key][drumCursor.col] = false);
        renderEditor(); saveSong();
      });
      clearLane('Clear kit', () => { DRUM_ROWS.forEach(r => s.drums[r.key] = new Array(totalSteps(s)).fill(false)); });
    } else {
      act('⤓ Import from pads', portFromPads);
      act('+ Add sample row', () => addSamplerRow(s));
    }
    return tools;
  }

  /**
   * The chord vocabulary, finally visible.
   *
   * DEGREES, DIATONIC_QUAL, QUALITIES, INVERSIONS and CHORD_LENGTHS have all
   * existed in this file since the beginning with NO user interface — the only
   * way to build a chord was to guess the right notes on the 88-key dock, and
   * a tap on the timeline with nothing built failed silently.
   */
  function buildChordPalette(s) {
    const wrap = el('div', 'chord-palette');
    const degrees = el('div', 'palette-degrees');
    DEGREES.forEach((d, i) => {
      const notes = degreeChordNotes(i, chordQual === 'auto' ? DIATONIC_QUAL[i] : chordQual, s.key);
      const b = el('button', 'degree-btn', nameChord(notes));
      b.type = 'button';
      b.title = `${d} — tap to arm, then tap or drag the timeline to place`;
      b.classList.toggle('armed', JSON.stringify(notes) === JSON.stringify(builtNotes));
      b.addEventListener('click', () => {
        builtNotes = notes.slice();
        previewNotes(s, builtNotes);
        refreshChords(s);
      });
      degrees.appendChild(b);
    });
    wrap.appendChild(degrees);

    const opts = el('div', 'palette-opts');
    const pick = (label, values, cur, onPick) => {
      const sel = el('select');
      values.forEach(v => sel.appendChild(opt(v.id ?? v, v.label ?? v, (v.id ?? v) === cur)));
      sel.addEventListener('change', () => onPick(sel.value));
      const l = el('label', 'palette-field');
      l.append(el('span', 'strip-label', label), sel);
      opts.appendChild(l);
      return sel;
    };
    pick('Quality', [{ id: 'auto', label: 'In key' }, ...QUALITIES.map(q => ({ id: q, label: q }))], chordQual, v => { chordQual = v; refreshChords(s); });
    pick('Length', CHORD_RES.map(r => ({ id: String(r.v), label: r.label })), String(chordRes), v => { chordRes = +v; });
    wrap.appendChild(opts);
    return wrap;
  }

  /* ---- 5. "what do I do next" ------------------------------------------- */
  /** Pure: the single most useful next action, derived from the song. */
  function nextStep(sg) {
    if (!sg.sections.length) return { text: 'Start with a section', cta: '+ Verse', act: () => addSection('Verse') };
    const s = sg.sections[sg.selected] || sg.sections[0];
    const name = s.name || s.type;
    if (!s.chords.some(Boolean)) return { text: `Give ${name} some chords`, cta: 'Fill 4 chords', act: () => fillChords(s) };
    if (!DRUM_ROWS.some(r => (s.drums[r.key] || []).some(drumVal))) return { text: `${name} has no beat`, cta: 'Add a groove', act: () => fillGroove(s) };
    if (!s.bass.some(Boolean)) return { text: `${name} has no bass`, cta: 'Follow the chords', act: () => { pushState(); autofillBass(s); renderEditor(); saveSong(); } };
    if (!previewedOnce) return { text: 'Hear the whole thing', cta: '▶ Play song', act: () => $('#btn-song-preview')?.click() };
    return { text: 'Take it to the decks', cta: '→ Deck A', act: () => $('#btn-song-deckA')?.click() };
  }

  function renderNextStep() {
    const host = $('#song-nextstep');
    if (!host) return;
    const step = nextStep(song);
    host.replaceChildren();
    host.append(el('span', 'next-text', step.text));
    const b = el('button', 'btn btn-mini next-cta', step.cta);
    b.type = 'button';
    b.addEventListener('click', step.act);
    host.appendChild(b);
  }

  // Which chord slot the editor targets (tracked per section).
  let chordSelSid = null;     // section whose chord state we currently hold
  let chordSelStep = null;    // start step of the selected placed chord
  let builtNotes = [];        // the chord currently built on the keyboard (midi notes)

  function previewNotes(s, notes, vel = 1) {
    if (notes && notes.length) voiceChord(_getCtx(), pvOut(), notes, _getCtx().currentTime + 0.02, 0.9, s.chordSound, vel, _pvNoise, patchFor(s, 'chords'));
  }

  /**
   * Patch the keyboard dock in place — never rebuild the 250-node keybed per
   * interaction (that was the main source of per-note jank, esp. on mobile).
   * Only the small controls row is regenerated; key states are re-classed.
   */
  function refreshSharedKeyboard(s) {
    const dock = document.getElementById('pad-keyboard-dock');
    if (!dock) return;
    const mode = PAD_MODES.find(m => m.key === activePadMode) || PAD_MODES[0];
    const status = dock.querySelector('.pad-keyboard-status');
    if (status) {
      const strong = status.querySelector('strong');
      if (strong) strong.textContent = mode.label;
      const hint = status.querySelector('.hint');
      if (hint) hint.textContent = modeSoundName(s, activePadMode);
    }
    const actions = dock.querySelector('.pad-keyboard-actions');
    if (actions) actions.replaceWith(buildSharedKeyboardControls(s));
    updateKeybedClasses(dock, s);
    const scale = dock.querySelector('.pad-keyboard-foot strong');
    if (scale) scale.textContent = `${NOTE_NAMES[s.key]} major`;
    // NOT renderInspector(s): this runs on every grid cell pointerdown and
    // every keybed tap. Rebuilding the inspector there tore down the patch
    // preview canvas, five range inputs and any open <details> mid-drag.
    // A full rebuild belongs to lane and section changes only — the scope
    // line is the sole part that has to track a keypress.
    updateInspectorScope(s);
  }

  /** Patch just the inspector's header — no teardown of the panel below it. */
  function updateInspectorScope(s) {
    const panel = $('#song-inspector');
    if (!panel || !s) return;
    const mode = PAD_MODES.find(m => m.key === activePadMode) || PAD_MODES[0];
    const head = panel.querySelector('.inspector-head');
    if (!head) return;
    const strong = head.querySelector('strong');
    if (strong) strong.textContent = mode.label;
    const hint = head.querySelector('.hint');
    if (hint) hint.textContent = modeSoundName(s, activePadMode);
  }

  /** Recompute every key's state classes without touching the DOM tree. */
  function updateKeybedClasses(dock, s) {
    const scalePcs = new Set(MAJOR.slice(0, 7).map(x => (s.key + x) % 12));
    dock.querySelectorAll('.shared-kbd .kbd-key').forEach(k => {
      k.className = sharedKeyClass(+k.dataset.midi, s, k.classList.contains('black'), scalePcs);
    });
  }

  function modeSoundName(s, mode) {
    if (!s) return 'No section';
    if (mode === 'chords') return (CHORD_SOUNDS.find(o => o.id === s.chordSound) || {}).label || 'Chords';
    if (mode === 'bass') return (BASS_SOUNDS.find(o => o.id === s.bassSound) || {}).label || 'Bass';
    if (mode === 'lead') return (LEAD_SOUNDS.find(o => o.id === s.leadSound) || {}).label || 'Lead';
    if (mode === 'drums') return (DRUM_KITS.find(o => o.id === s.drumKit) || {}).label || 'Drums';
    if (mode === 'sampler') return findPorted(smpSel.sampleId)?.name || 'No sample selected';
    return '';
  }

  function buildSharedKeyboardDock(s) {
    const dock = el('section', 'pad-keyboard-dock');
    dock.id = 'pad-keyboard-dock';

    const top = el('div', 'pad-keyboard-top');
    // The five mode tabs used to live here AND as the five lane badges AND as
    // the lane headings — three copies of one control. The instrument rail is
    // now the single home; the dock just says what it is playing into.
    const status = el('div', 'pad-keyboard-status');
    const mode = PAD_MODES.find(m => m.key === activePadMode) || PAD_MODES[0];
    status.append(el('span', 'label-sm', 'Playing into'));
    status.append(el('strong', null, mode.label));
    status.append(el('span', 'hint', modeSoundName(s, activePadMode)));

    top.append(status, buildSharedKeyboardControls(s));
    dock.append(top, buildSharedKeybed(s));

    const foot = el('div', 'pad-keyboard-foot');
    const jumps = el('div', 'kbd-range-jumps');
    [
      { label: 'A0', midi: 21 },
      { label: 'C2', midi: 36 },
      { label: 'C4', midi: 60 },
      { label: 'C6', midi: 84 },
      { label: 'C8', midi: 108 },
    ].forEach(j => {
      const b = el('button', 'kbd-range-jump', j.label);
      b.type = 'button';
      b.title = `Jump keyboard to ${j.label}`;
      b.addEventListener('click', () => scrollSharedKeyboardToMidi(j.midi));
      jumps.appendChild(b);
    });
    foot.append(
      el('span', 'label-sm', 'Scale'),
      el('strong', null, `${NOTE_NAMES[s.key]} major`),
      el('span', 'hint', '88 keys A0–C8 · swipe/scroll horizontally · active track receives input'),
      jumps
    );
    dock.appendChild(foot);
    return dock;
  }

  function scrollSharedKeyboardToMidi(midi) {
    const kbd = document.querySelector('.shared-kbd');
    const key = kbd && kbd.querySelector(`.kbd-key[data-midi="${midi}"]`);
    if (!kbd || !key) return;
    const left = Math.max(0, key.offsetLeft - (kbd.clientWidth / 2) + (key.clientWidth / 2));
    kbd.scrollTo({ left, behavior: 'smooth' });
  }

  function buildSharedKeyboardControls(s) {
    const controls = el('div', 'pad-keyboard-actions');
    if (activePadMode === 'chords') {
      const readout = el('div', 'chord-readout' + (builtNotes.length ? '' : ' rest'), builtNotes.length ? nameChord(builtNotes) : 'Tap keys to build a chord');
      const hear = el('button', 'btn btn-mini', '▶ Hear'); hear.disabled = !builtNotes.length; hear.addEventListener('click', () => previewNotes(s, builtNotes));
      const clr = el('button', 'btn btn-mini', 'Clear'); clr.addEventListener('click', () => { builtNotes = []; refreshChords(s); });
      controls.append(readout, hear, clr);
      if (chordSelStep != null && s.chords[chordSelStep]) {
        const rm = el('button', 'btn btn-mini btn-danger', 'Remove placed');
        rm.addEventListener('click', () => { s.chords[chordSelStep] = null; chordSelStep = null; refreshChords(s); saveSong(); });
        controls.appendChild(rm);
      }
    } else if (activePadMode === 'bass' || activePadMode === 'lead') {
      const cur = noteCursor[activePadMode] || { row: 0, col: 0 };
      controls.append(el('div', 'pad-cursor-readout', `Step ${cur.col + 1} · ${bassRowName(cur.row, s.key)}`));
      const erase = el('button', 'btn btn-mini', 'Erase step');
      erase.addEventListener('click', () => {
        pushState();
        notesClearRange(s[activePadMode], cur.col, cur.col + 1);
        s[activePadMode][cur.col] = null;
        renderEditor();
        saveSong();
      });
      const adv = el('button', 'btn btn-mini', 'Advance');
      adv.addEventListener('click', () => { noteCursor[activePadMode].col = Math.min(totalSteps(s) - 1, cur.col + 1); refreshSharedKeyboard(s); });
      controls.append(erase, adv);
    } else if (activePadMode === 'drums') {
      const row = DRUM_ROWS.find(r => r.key === drumCursor.key) || DRUM_ROWS[DRUM_ROWS.length - 1];
      controls.append(el('div', 'pad-cursor-readout', `Step ${drumCursor.col + 1} · ${row.label}`));
      const clr = el('button', 'btn btn-mini', 'Clear step');
      clr.addEventListener('click', () => {
        pushState();
        DRUM_ROWS.forEach(r => s.drums[r.key][drumCursor.col] = false);
        renderEditor();
        saveSong();
      });
      controls.appendChild(clr);
    } else {
      controls.append(el('div', 'pad-cursor-readout', `Transpose ${noteLabel(60 + smpSel.transpose)}`));
      const hear = el('button', 'btn btn-mini', '▶ Hear'); hear.disabled = !findPorted(smpSel.sampleId);
      hear.addEventListener('click', () => previewSampleConfig(s));
      controls.appendChild(hear);
    }
    return controls;
  }

  function buildSharedKeybed(s) {
    const kbd = el('div', 'chord-kbd shared-kbd');
    const inner = el('div', 'kbd-inner');
    const whiteMidis = [];
    const scalePcs = new Set(MAJOR.slice(0, 7).map(x => (s.key + x) % 12));
    for (let m = KBD_LO; m <= KBD_HI; m++) if (!BLACK_PCS.includes(m % 12)) whiteMidis.push(m);
    inner.style.width = (whiteMidis.length * KW) + 'px';
    whiteMidis.forEach((m, i) => {
      const wk = el('button', sharedKeyClass(m, s, false, scalePcs));
      wk.dataset.midi = m; wk.style.left = (i * KW) + 'px';
      if (m === KBD_LO || m % 12 === 0 || m === KBD_HI) wk.appendChild(el('span', 'kbd-label', keyName(m)));
      inner.appendChild(wk);
      if ([0, 2, 5, 7, 9].includes(m % 12) && m + 1 <= KBD_HI) {
        const bm = m + 1;
        const bk = el('button', sharedKeyClass(bm, s, true, scalePcs));
        bk.dataset.midi = bm; bk.style.left = ((i + 1) * KW - KBW / 2) + 'px';
        inner.appendChild(bk);
      }
    });
    inner.addEventListener('click', e => {
      const k = e.target.closest('.kbd-key'); if (!k) return;
      handleSharedKeyPress(s, +k.dataset.midi);
    });
    kbd.appendChild(inner);
    setTimeout(() => { if (!kbd.dataset.scrolled && kbd.scrollWidth > kbd.clientWidth) kbd.scrollLeft = Math.max(0, ((60 - KBD_LO) / (KBD_HI - KBD_LO)) * kbd.scrollWidth - kbd.clientWidth / 2); }, 0);
    return kbd;
  }

  function sharedKeyClass(m, s, black, scalePcs) {
    let cls = 'kbd-key ' + (black ? 'black' : 'white');
    if (scalePcs.has(m % 12)) cls += ' scale';
    if (activePadMode === 'chords' && builtNotes.includes(m)) cls += ' sel';
    if (activePadMode === 'sampler' && m === 60 + smpSel.transpose) cls += ' sel';
    if (activePadMode === 'bass' || activePadMode === 'lead') {
      const cur = noteCursor[activePadMode] || { row: 0 };
      const row = nearestBassRow(m % 12, s.key);
      if (row === cur.row && scalePcs.has(m % 12)) cls += ' cursor';
    }
    if (activePadMode === 'drums') {
      const idx = ((m - KBD_LO) % DRUM_ROWS.length + DRUM_ROWS.length) % DRUM_ROWS.length;
      if (DRUM_ROWS[idx].key === drumCursor.key) cls += ' cursor';
    }
    return cls;
  }

  function handleSharedKeyPress(s, midi, vel = 1) {
    if (activePadMode === 'chords') {
      const idx = builtNotes.indexOf(midi);
      if (idx >= 0) builtNotes.splice(idx, 1); else builtNotes.push(midi);
      builtNotes.sort((a, b) => a - b);
      previewNotes(s, [midi], vel);
      refreshChords(s);
      return;
    }
    if (activePadMode === 'bass' || activePadMode === 'lead') {
      const kind = activePadMode;
      const cur = noteCursor[kind] || { row: 0, col: 0 };
      const row = nearestBassRow(midi % 12, s.key);
      const col = Math.max(0, Math.min(totalSteps(s) - 1, cur.col || 0));
      pushState();
      notesClearRange(s[kind], col, col + 1);
      s[kind][col] = { r: row, len: 1 };
      noteCursor[kind] = { row, col: Math.min(totalSteps(s) - 1, col + 1) };
      kind === 'bass' ? previewBass(s, row, vel) : previewLead(s, row, vel);
      refreshLaneGrid(s, kind);        // targeted — no full editor rebuild per note
      refreshSharedKeyboard(s);
      saveSong();
      return;
    }
    if (activePadMode === 'drums') {
      const idx = ((midi - KBD_LO) % DRUM_ROWS.length + DRUM_ROWS.length) % DRUM_ROWS.length;
      const row = DRUM_ROWS[idx];
      const col = Math.max(0, Math.min(totalSteps(s) - 1, drumCursor.col || 0));
      pushState();
      const nv = (drumVal(s.drums[row.key][col]) + 1) % 4; // same cycle as tapping the grid
      s.drums[row.key][col] = nv;
      drumCursor = { key: row.key, col: Math.min(totalSteps(s) - 1, col + 1) };
      if (nv) previewDrum(s, row.key, (DRUM_VELS[nv] || 1) * vel);
      refreshLaneGrid(s, 'drums');     // targeted — no full editor rebuild per hit
      refreshSharedKeyboard(s);
      saveSong();
      return;
    }
    smpSel.transpose = midi - 60;
    if (findPorted(smpSel.sampleId)) previewSampleConfig(s);
    refreshSamplerConfig(s);
    refreshSharedKeyboard(s);
  }

  function fmtMixValue(prop, value) {
    if (prop === 'volume' || prop === 'echo' || prop === 'reverb') return Math.round(value * 100) + '%';
    if (prop === 'pan') return value === 0 ? 'C' : `${value < 0 ? 'L' : 'R'}${Math.round(Math.abs(value) * 100)}`;
    if (prop === 'tone') return value < 0.46 ? 'Dark' : (value > 0.62 ? 'Bright' : 'Neutral');
    return String(value);
  }

  function mixRange(s, track, prop, label, min, max, step) {
    const mix = mixFor(s, track);
    const row = el('label', 'track-mix-row');
    const top = el('span', 'track-mix-row-top');
    const out = el('strong', null, fmtMixValue(prop, mix[prop]));
    top.append(el('span', null, label), out);
    const input = el('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = mix[prop];
    let editing = false;
    const begin = () => { if (!editing) { pushState(); editing = true; } };
    input.addEventListener('pointerdown', begin);
    input.addEventListener('keydown', begin);
    input.addEventListener('input', () => {
      mix[prop] = Number(input.value);
      out.textContent = fmtMixValue(prop, mix[prop]);
      renderCache.clear();
      saveSong();
    });
    input.addEventListener('change', () => { editing = false; saveSong(); });
    row.append(top, input);
    return row;
  }

  function buildTrackMixPanel(s) {
    const track = activePadMode;
    const mode = PAD_MODES.find(m => m.key === track) || PAD_MODES[0];
    const mix = mixFor(s, track);
    const panel = el('div', 'track-mix-panel');
    const head = el('div', 'track-mix-head');
    head.append(el('span', 'label-sm', 'Track mix + FX'), el('strong', null, mode.label));

    const toggles = el('div', 'track-mix-toggles');
    const toggleBtn = (prop, label) => {
      const b = el('button', 'btn btn-mini mix-toggle' + (mix[prop] ? ' active' : ''), label);
      b.type = 'button';
      b.addEventListener('click', () => {
        pushState();
        mix[prop] = !mix[prop];
        renderCache.clear();
        renderInspector(s);
        saveSong();
      });
      return b;
    };
    toggles.append(toggleBtn('mute', 'Mute'), toggleBtn('solo', 'Solo'));

    const ranges = el('div', 'track-mix-ranges');
    ranges.append(
      mixRange(s, track, 'volume', 'Volume', 0, 1.2, 0.01),
      mixRange(s, track, 'pan', 'Pan', -1, 1, 0.01),
      mixRange(s, track, 'tone', 'Tone', 0, 1, 0.01),
      mixRange(s, track, 'echo', 'Echo', 0, 0.85, 0.01),
      mixRange(s, track, 'reverb', 'Reverb', 0, 0.85, 0.01)
    );

    const actions = el('div', 'track-mix-actions');
    const reset = el('button', 'btn btn-mini', 'Reset track');
    reset.type = 'button';
    reset.addEventListener('click', () => {
      pushState();
      ensureMix(s)[track] = { ...TRACK_MIX_DEFAULTS[track] };
      renderCache.clear();
      renderInspector(s);
      saveSong();
    });
    const applyAll = el('button', 'btn btn-mini', 'Apply to all sections');
    applyAll.type = 'button';
    applyAll.title = 'Copy this track mix/FX setup to the same track in every song section';
    applyAll.addEventListener('click', () => {
      pushState();
      const copy = { ...mixFor(s, track) };
      song.sections.forEach(sec => { ensureMix(sec)[track] = { ...copy }; });
      renderCache.clear();
      renderEditor();
      saveSong();
      _toast(`${mode.label} mix copied to all sections.`);
    });
    actions.append(reset, applyAll);
    panel.append(head, toggles, ranges, actions);
    return panel;
  }

  /* ---------------- synth editor ----------------
   * Renders controls straight from the engine's parameter schema, so adding a
   * parameter to synth.js automatically gives it a control here. */
  const openSynthSections = new Set(['filter']); // which accordion groups are expanded
  let _patchPvToken = 0, _patchPvTimer = null, _auditionTimer = null;

  function fmtParam(unit, v) {
    switch (unit) {
      case 's': return v < 1 ? Math.round(v * 1000) + ' ms' : v.toFixed(2) + ' s';
      case 'hz': return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : Math.round(v) + ' Hz';
      case 'ct': return (v > 0 ? '+' : '') + (Math.round(v * 10) / 10) + ' ¢';
      case 'pct': return Math.round(v * 100) + '%';
      case 'x': return '×' + (Math.round(v * 100) / 100);
      case 'amp': return Math.round(v * 100) / 100;
      case 'int': return String(Math.round(v));
      case 'wave': return WAVE_LABELS[Math.round(v)] || '—';
      case 'filtertype': return FILTER_LABELS[Math.round(v)] || '—';
      default: return String(v);
    }
  }
  const WAVE_LABELS = ['Sine', 'Triangle', 'Sawtooth', 'Square'];
  const FILTER_LABELS = ['Low-pass', 'High-pass', 'Band-pass'];

  /** Audition the lane's current patch (debounced) so edits are audible live. */
  function auditionPatch(s, track) {
    clearTimeout(_auditionTimer);
    _auditionTimer = setTimeout(() => {
      const studio = $('#studio');
      if (!studio || getComputedStyle(studio).display === 'none') return; // left the studio — stay silent
      if (track === 'chords') previewNotes(s, builtNotes.length ? builtNotes : [60 + s.key, 64 + s.key, 67 + s.key]);
      else if (track === 'bass') previewBass(s, 0);
      else if (track === 'lead') previewLead(s, 0);
    }, 90);
  }

  /** Draw a REAL rendered note of the current patch (replaces the old fake bar row). */
  let _patchPvCache = null; // { sig, data } — repaint without re-rendering when unchanged
  // A theme flip only changes the ink; the rendered audio is unchanged, so
  // repaint from the cache rather than re-rendering offline.
  onThemeChange(() => {
    const cv = document.getElementById('patch-preview');
    if (cv && _patchPvCache && cv.clientWidth) paintWave(cv, _patchPvCache.data);
  });
  function drawPatchPreview(canvas, s, track) {
    if (!canvas || !PATCH_FAMILY[track]) return;
    if (!canvas.clientWidth) return; // panel hidden (small-screen layouts) — nothing to draw
    const sig = track + '|' + trackSound(s, track) + '|' + JSON.stringify((s.patches || {})[patchKey(s, track)] || 0);
    if (_patchPvCache && _patchPvCache.sig === sig) { paintWave(canvas, _patchPvCache.data); return; }
    const token = ++_patchPvToken;
    clearTimeout(_patchPvTimer);
    _patchPvTimer = setTimeout(async () => {
      try {
        const sr = _getCtx().sampleRate;
        const dur = 0.75;
        const oc = new OfflineAudioContext(1, Math.ceil(sr * dur), sr);
        const noise = oc.createBuffer(1, sr, sr);
        noise.getChannelData(0).set(noiseData(sr, 1));
        const midi = track === 'bass' ? 40 : track === 'lead' ? 72 : 60;
        playInstrument(PATCH_FAMILY[track], trackSound(s, track), oc, oc.destination, midi, 0.005, 0.42, 1,
          { noise, ndx: 0, count: 1, patch: patchFor(s, track) });
        const buf = await oc.startRendering();
        if (token !== _patchPvToken) return;
        _patchPvCache = { sig, data: buf.getChannelData(0) };
        if (canvas.isConnected) paintWave(canvas, _patchPvCache.data);
        else { const cv = document.getElementById('patch-preview'); if (cv) paintWave(cv, _patchPvCache.data); }
      } catch (e) { /* the preview is a nicety — never let it break the editor */ }
    }, 140);
  }

  function paintWave(canvas, data) {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(40, canvas.clientWidth), h = Math.max(24, canvas.clientHeight);
    canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr);
    const g = canvas.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    let peak = 0;
    for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
    const norm = peak > 1e-5 ? 0.92 / peak : 0;
    const mid = h / 2;
    const tc = themeColors();
    g.strokeStyle = tc.line;
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, tc['patch-hi']); grad.addColorStop(1, tc['patch-lo']);
    g.fillStyle = grad;
    const per = data.length / w;
    for (let x = 0; x < w; x++) {
      let lo = 1, hi = -1;
      const a = Math.floor(x * per), b = Math.min(data.length, Math.floor((x + 1) * per));
      for (let i = a; i < b; i++) { const v = data[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
      if (lo > hi) continue;
      const y1 = mid - hi * norm * mid, y2 = mid - lo * norm * mid;
      g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
    }
  }

  function buildSynthPanel(s) {
    const track = activePadMode;
    const fam = PATCH_FAMILY[track];
    if (!fam) return null; // drums & sampler lanes have no synth patch
    const sound = trackSound(s, track);
    const patch = patchFor(s, track);
    const schema = ENGINE_SCHEMA[patch.engine] || [];

    const panel = el('div', 'synth-panel' + (useSamples ? ' sampled' : ''));
    const head = el('div', 'synth-head');
    const title = el('span', 'label-sm', 'Synth');
    const edited = el('span', 'synth-edited' + (patchIsEdited(s, track) ? '' : ' hidden'), 'EDITED');
    head.append(title, el('strong', null, ENGINE_LABELS[patch.engine] || patch.engine), edited);
    panel.appendChild(head);

    if (useSamples) {
      panel.appendChild(el('span', 'hint', 'Sampled · GM engine is active — switch Sound to Synth to hear these controls.'));
    }

    // If none of THIS engine's sections is expanded (they're remembered by key,
    // and e.g. FM has no "filter"), open the first so the panel never looks empty.
    if (!schema.some(sec => openSynthSections.has(sec.key)) && schema.length) {
      openSynthSections.add(schema[0].key);
    }

    schema.forEach(sec => {
      const box = el('details', 'synth-sec');
      if (openSynthSections.has(sec.key)) box.open = true;
      box.addEventListener('toggle', () => {
        if (box.open) openSynthSections.add(sec.key); else openSynthSections.delete(sec.key);
      });
      const sum = el('summary', null, sec.label);
      box.appendChild(sum);
      const body = el('div', 'synth-sec-body');
      sec.params.forEach(pr => body.appendChild(buildParamRow(s, track, fam, sound, patch, pr)));
      box.appendChild(body);
      panel.appendChild(box);
    });

    const actions = el('div', 'synth-actions');
    const hear = el('button', 'btn btn-mini', '▶ Hear');
    hear.type = 'button';
    hear.addEventListener('click', () => auditionPatch(s, track));
    const init = el('button', 'btn btn-mini', 'Reset patch');
    init.type = 'button';
    init.title = 'Discard every edit and return this sound to its factory design';
    init.addEventListener('click', () => {
      if (!patchIsEdited(s, track)) return;
      pushState();
      if (s.patches) delete s.patches[patchKey(s, track)];
      prunePatches(s);
      renderCache.clear();
      renderInspector(s);
      saveSong();
      _toast('Patch reset to factory.');
    });
    const all = el('button', 'btn btn-mini', 'Apply to all sections');
    all.type = 'button';
    all.title = 'Copy this patch to every section that uses the same sound';
    all.addEventListener('click', () => {
      pushState();
      const key = patchKey(s, track);
      const copy = { ...((s.patches || {})[key] || {}) };
      song.sections.forEach(sec => {
        if (sec === s) return;
        if (patchKey(sec, track) !== key) return; // only sections on the same sound
        if (!sec.patches) sec.patches = {};
        if (Object.keys(copy).length) sec.patches[key] = { ...copy }; else delete sec.patches[key];
        prunePatches(sec); // never leave an empty `patches: {}` behind
      });
      renderCache.clear();
      saveSong();
      _toast('Patch copied to matching sections.');
    });
    actions.append(hear, init, all);
    panel.appendChild(actions);
    return panel;
  }

  const ENGINE_LABELS = { subtractive: 'Analog', fm: 'FM', organ: 'Drawbar', pluck: 'String' };

  function buildParamRow(s, track, fam, sound, patch, pr) {
    const row = el('label', 'track-mix-row synth-row');
    const top = el('span', 'track-mix-row-top');
    const value = patch.params[pr.key];
    const out = el('strong', null, fmtParam(pr.unit, value));
    const name = el('span', null, pr.label);
    const isDefault = Math.abs(value - (factoryValue(fam, sound, pr.key) ?? value)) < 1e-9;
    if (!isDefault) name.classList.add('param-edited');
    top.append(name, out);
    row.appendChild(top);

    const commit = (v) => {
      const ov = patchOverrides(s, track, true);
      const fac = factoryValue(fam, sound, pr.key);
      // Keep the song JSON sparse: an edit back to the factory value is not an edit.
      if (fac != null && Math.abs(v - fac) < 1e-9) delete ov[pr.key];
      else ov[pr.key] = v;
      prunePatches(s);
      out.textContent = fmtParam(pr.unit, v);
      name.classList.toggle('param-edited', !(fac != null && Math.abs(v - fac) < 1e-9));
      const badge = row.closest('.synth-panel')?.querySelector('.synth-edited');
      if (badge) badge.classList.toggle('hidden', !patchIsEdited(s, track));
      renderCache.clear();
      saveSong();
      drawPatchPreview(document.getElementById('patch-preview'), s, track);
    };

    if (pr.unit === 'wave' || pr.unit === 'filtertype') {
      const labels = pr.unit === 'wave' ? WAVE_LABELS : FILTER_LABELS;
      const sel = el('select', 'synth-select');
      labels.forEach((lbl, i) => sel.appendChild(opt(String(i), lbl, i === Math.round(value))));
      sel.addEventListener('change', () => { pushState(); commit(Number(sel.value)); auditionPatch(s, track); });
      row.appendChild(sel);
      return row;
    }

    const input = el('input');
    input.type = 'range';
    input.min = pr.min; input.max = pr.max; input.step = pr.step;
    input.value = value;
    input.setAttribute('aria-label', pr.label);
    input.setAttribute('aria-valuetext', fmtParam(pr.unit, value)); // SRs hear "12 ms", not "0.012"
    let editing = false, idleTimer = null;
    const begin = () => { if (!editing) { pushState(); editing = true; } };
    // A keyboard user taps an arrow many times for one logical edit; range
    // inputs fire `change` per press, so end the undo group on idle instead —
    // a burst of presses becomes ONE undo entry, not thirty.
    const endSoon = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { editing = false; }, 600); };
    input.addEventListener('pointerdown', begin);
    input.addEventListener('keydown', begin);
    input.addEventListener('input', () => {
      commit(Number(input.value));
      input.setAttribute('aria-valuetext', fmtParam(pr.unit, Number(input.value)));
    });
    input.addEventListener('change', () => { endSoon(); auditionPatch(s, track); saveSong(); });
    input.addEventListener('blur', () => { clearTimeout(idleTimer); editing = false; });
    row.appendChild(input);
    return row;
  }

  /**
   * The inspector answers one question: "what does the focused instrument
   * sound like, in this section?" One scrolling column, no tabs — mix and
   * patch have to be co-visible because you adjust one while listening to
   * the other.
   *
   * Removed from here deliberately: the action row (every one of those
   * buttons now has exactly one home on the bench), the four stat chips (Key
   * and Bars are on the section strip, Steps on the ruler) and the six
   * "meters", which were static note-density bars dressed as VUs — that
   * density now shows as flat dots on the section chips, where it answers a
   * real question ("which section has no drums?").
   */
  function renderInspector(s) {
    const panel = $('#song-inspector');
    if (!panel) return;
    const keepScroll = panel.scrollTop;
    if (!s) {
      panel.replaceChildren(el('div', 'song-inspector-empty', 'Add a section to start building a song.'));
      return;
    }
    const mode = PAD_MODES.find(m => m.key === activePadMode) || PAD_MODES[0];
    const sectionName = s.name || s.type;

    const head = el('div', 'inspector-head');
    head.append(el('span', 'label-sm', 'Instrument'), el('strong', null, mode.label),
      el('span', 'hint', `${modeSoundName(s, activePadMode)} · in ${sectionName}`));

    // The lane's SOUND selector, for the focused lane only. All four used to
    // sit in the section header at once, three of them for lanes you were not
    // looking at.
    const soundBox = el('div', 'insp-sound');
    const SOUND_OF = {
      chords: [CHORD_SOUNDS, 'chordSound'], bass: [BASS_SOUNDS, 'bassSound'],
      lead: [LEAD_SOUNDS, 'leadSound'], drums: [DRUM_KITS, 'drumKit'],
    };
    const soundSpec = SOUND_OF[activePadMode];
    if (soundSpec) {
      const [list, prop] = soundSpec;
      const sel = el('select');
      sel.setAttribute('aria-label', mode.label + ' sound');
      list.forEach(o => sel.appendChild(opt(o.id, o.label, o.id === s[prop])));
      sel.addEventListener('change', () => {
        pushState();
        s[prop] = sel.value;
        renderCache.clear();
        renderInspector(s);
        // Re-focus the control the change event fired on: renderInspector
        // rebuilds the select, which would otherwise vanish mid-interaction.
        $('#song-inspector .insp-sound select')?.focus();
        buildInstrumentRail && refreshInstrumentRail(s);
        saveSong();
      });
      soundBox.append(el('span', 'strip-label', 'Sound'), sel);
    } else {
      soundBox.append(el('span', 'hint', 'Sampler rows carry their own samples.'));
    }

    // A real rendered note of the lane's current patch — not decoration.
    const wave = el('div', 'inspector-wave');
    if (PATCH_FAMILY[activePadMode]) {
      const cv = el('canvas', 'patch-preview');
      cv.id = 'patch-preview';
      wave.appendChild(cv);
    } else {
      wave.appendChild(el('span', 'hint', activePadMode === 'drums' ? 'Drum kit — pick a kit above' : 'Sampler lane'));
    }

    const synth = buildSynthPanel(s);
    const kids = [head, soundBox, wave, buildTrackMixPanel(s)];
    if (synth) {
      const adv = el('details', 'inspector-advanced');
      adv.open = openSynthAdvanced;
      adv.addEventListener('toggle', () => { openSynthAdvanced = adv.open; });
      adv.append(el('summary', null, 'Advanced — synth engine'), synth);
      kids.push(adv);
    }
    panel.replaceChildren(...kids);
    if (keepScroll) panel.scrollTop = keepScroll;
    if (PATCH_FAMILY[activePadMode]) drawPatchPreview(panel.querySelector('#patch-preview'), s, activePadMode);
  }

  /** Repaint the instrument rail's labels and thumbnails without a rebuild. */
  function refreshInstrumentRail(s) {
    document.querySelectorAll('.inst-tab').forEach(tab => {
      const kind = tab.dataset.lane;
      const nm = tab.querySelector('.inst-sound');
      if (nm) nm.textContent = modeSoundName(s, kind);
      const mini = tab.querySelector('.inst-mini');
      if (mini) drawLaneMini(mini, s, kind);
    });
  }

  // Single-row chord timeline (same steps as bass/lead) + a chord-name strip on top.
  function buildChordRow(s) {
    const cols = totalSteps(s), spb = stepsPerBar(s);
    if (chordSelStep != null && (chordSelStep >= cols || !s.chords[chordSelStep])) chordSelStep = null;
    const grid = el('div', 'seq-grid chord-grid');
    grid.style.setProperty('--cols', cols);
    grid.appendChild(el('div', 'chord-now')); // playing-chord name during playback
    const cov = chordCoverage(s, cols);
    const strip = el('div', 'chord-name-strip');
    for (let c = 0; c < cols; c++) {
      const ch = s.chords[c];
      if (ch) { const lbl = el('div', 'chord-name-cell', ch.name); lbl.style.gridColumn = (c + 2) + ' / span ' + ch.len; strip.appendChild(lbl); }
    }
    grid.appendChild(strip);
    const row = el('div', 'seq-row');
    row.appendChild(el('span', 'seq-row-label', 'Chords'));
    for (let c = 0; c < cols; c++) {
      const cv = cov[c];
      let cls = 'seq-cell' + cellMarks(c, s.subdiv, spb);
      if (cv) cls += cv.start ? ' on' : ' on tied';
      if (cv && cv.startStep === chordSelStep) cls += ' sel';
      const cell = el('button', cls); cell.dataset.col = c;
      if (cv && cv.start) cell.title = cv.name;
      row.appendChild(cell);
    }
    grid.appendChild(row);
    grid.appendChild(el('div', 'seq-playhead'));
    attachChordPlace(grid, s);
    attachChordHoverAudition(row, s);
    return grid;
  }

  // Hover a placed chord to hear it quietly (mouse/trackpad only — touch has
  // no hover; debounced so sweeping the row doesn't machine-gun chords).
  let _hoverAudTimer = null, _hoverAudStep = null;
  function attachChordHoverAudition(rowEl, s) {
    if (!matchMedia('(pointer: fine)').matches) return;
    rowEl.addEventListener('pointerover', (e) => {
      const cell = e.target.closest?.('.seq-cell.on');
      if (!cell || sectionPlay) return;
      const start = chordStartCovering(s, +cell.dataset.col);
      if (start == null || start === _hoverAudStep) return;
      _hoverAudStep = start;
      clearTimeout(_hoverAudTimer);
      _hoverAudTimer = setTimeout(() => {
        const ch = s.chords[start];
        if (ch) voiceChord(_getCtx(), pvOut(), ch.notes, _getCtx().currentTime + 0.02, 0.55, s.chordSound, 0.55, _pvNoise, patchFor(s, 'chords'));
      }, 150);
    });
    rowEl.addEventListener('pointerleave', () => { clearTimeout(_hoverAudTimer); _hoverAudStep = null; });
  }

  function attachChordPlace(grid, s) {
    const colAt = e => {
      let cell = e.target && e.target.closest ? e.target.closest('.seq-cell') : null;
      if (!cell || !grid.contains(cell)) { const t = document.elementFromPoint(e.clientX, e.clientY); cell = t && t.closest ? t.closest('.seq-cell') : null; }
      return (cell && grid.contains(cell)) ? +cell.dataset.col : null;
    };
    const paint = (a, b) => grid.querySelectorAll('.seq-row .seq-cell').forEach(c => c.classList.toggle('drag', +c.dataset.col >= a && +c.dataset.col <= b));
    const clearPaint = () => grid.querySelectorAll('.seq-cell.drag').forEach(c => c.classList.remove('drag'));
    let drag = null;
    grid.addEventListener('pointerdown', e => {
      const c = colAt(e); if (c == null) return;
      if (activePadMode !== 'chords') setActivePadMode('chords');
      e.preventDefault();
      beginGesture();
      drag = { startCol: c, curCol: c };
      try { grid.setPointerCapture(e.pointerId); } catch (x) {}
      paint(c, c);
    });
    grid.addEventListener('pointermove', e => {
      if (!drag) return;
      const c = colAt(e); if (c == null || c === drag.curCol) return;
      drag.curCol = c;
      paint(Math.min(drag.startCol, drag.curCol), Math.max(drag.startCol, drag.curCol));
    });
    grid.addEventListener('pointerup', () => {
      if (!drag) return;
      clearPaint();
      const a = Math.min(drag.startCol, drag.curCol), b = Math.max(drag.startCol, drag.curCol);
      drag = null;
      if (a === b) {
        const start = chordStartCovering(s, a);
        if (start != null) {                              // tap a placed chord → select & load it (tap again removes)
          if (chordSelStep === start) { s.chords[start] = null; chordSelStep = null; }
          else { chordSelStep = start; builtNotes = s.chords[start].notes.slice(); }
        } else if (builtNotes.length) {                   // tap empty with a built chord → drop a 1-step chord
          notesClearRange(s.chords, a, a + 1); s.chords[a] = makeChordObj(builtNotes, 1); chordSelStep = a; previewNotes(s, builtNotes);
        }
      } else if (builtNotes.length) {                     // drag with a built chord → place it across the range
        notesClearRange(s.chords, a, b + 1); s.chords[a] = makeChordObj(builtNotes, b - a + 1); chordSelStep = a; previewNotes(s, builtNotes);
      }
      endGesture();
      refreshChords(s);
      saveSong();
    });
    // iOS fires pointercancel on a long-press; without dropping the snapshot
    // the gesture leaves a phantom undo entry that reverts nothing.
    grid.addEventListener('pointercancel', () => { clearPaint(); if (drag) { drag = null; dropState(); } });
  }

  // Rebuild the chord keyboard + timeline in place, preserving both scroll positions.
  function refreshChords(s) {
    const body = document.getElementById('chord-lane-body');
    if (!body) { renderEditor(); return; }
    const oldRow = body.querySelector('.chord-grid');
    const rs = oldRow ? oldRow.scrollLeft : 0;
    body.innerHTML = '';
    body.append(buildChordRow(s));
    const nr = body.querySelector('.chord-grid'); if (nr) nr.scrollLeft = rs;
    refreshSharedKeyboard(s);
  }

  // Map each step column to {r, start} for the note covering it (or null).
  function noteCoverage(arr, cols) {
    const cov = new Array(cols).fill(null);
    for (let i = 0; i < cols; i++) { const n = arr[i]; if (n) for (let k = 0; k < n.len && i + k < cols; k++) if (!cov[i + k]) cov[i + k] = { r: n.r, start: k === 0 }; }
    return cov;
  }
  // Trim/remove notes overlapping [from,to) so the lane stays monophonic.
  function notesClearRange(arr, from, to) {
    for (let i = 0; i < arr.length; i++) {
      const n = arr[i]; if (!n) continue;
      const ns = i, ne = i + n.len;
      if (ns >= to || ne <= from) continue;
      if (ns < from) { n.len = from - ns; if (n.len <= 0) arr[i] = null; } // trim a note that started earlier
      else arr[i] = null;                                                  // remove notes starting in range
    }
  }
  // One grid for bass/lead. Click a cell = a single-step note; drag across cells = a sustained note.
  function buildNoteGrid(s, kind) {
    const arr = s[kind];
    const grid = el('div', 'seq-grid ' + (kind === 'bass' ? 'bass-grid' : 'lead-grid'));
    const cols = totalSteps(s), spb = stepsPerBar(s);
    grid.style.setProperty('--cols', cols);
    const cov = noteCoverage(arr, cols);
    for (let r = MAJOR.length - 1; r >= 0; r--) {
      const rowEl = el('div', 'seq-row');
      rowEl.appendChild(el('span', 'seq-row-label', bassRowName(r, s.key)));
      for (let c = 0; c < cols; c++) {
        let cls = 'seq-cell' + cellMarks(c, s.subdiv, spb);
        const cv = cov[c];
        if (cv && cv.r === r) cls += cv.start ? ' on' : ' on tied';
        const cursor = noteCursor[kind] || {};
        if (activePadMode === kind && cursor.row === r && cursor.col === c) cls += ' cursor-cell';
        const cell = el('button', cls);
        cell.dataset.row = r; cell.dataset.col = c;
        rowEl.appendChild(cell);
      }
      grid.appendChild(rowEl);
    }
    grid.appendChild(el('div', 'seq-playhead'));
    attachNoteDrag(grid, s, kind);
    return grid;
  }
  function attachNoteDrag(grid, s, kind) {
    const arr = s[kind];
    const preview = kind === 'bass' ? previewBass : previewLead;
    const cellAt = e => {
      let cell = e.target && e.target.closest ? e.target.closest('.seq-cell') : null; // works for pointerdown
      if (!cell || !grid.contains(cell)) { const t = document.elementFromPoint(e.clientX, e.clientY); cell = t && t.closest ? t.closest('.seq-cell') : null; } // moves (during capture)
      return (cell && grid.contains(cell)) ? { row: +cell.dataset.row, col: +cell.dataset.col } : null;
    };
    const paint = (row, a, b) => grid.querySelectorAll('.seq-cell').forEach(c => c.classList.toggle('drag', +c.dataset.row === row && +c.dataset.col >= a && +c.dataset.col <= b));
    const clearPaint = () => grid.querySelectorAll('.seq-cell.drag').forEach(c => c.classList.remove('drag'));
    let drag = null;
    grid.addEventListener('pointerdown', e => {
      const c = cellAt(e); if (!c) return;
      if (activePadMode !== kind) setActivePadMode(kind); // sync lane focus classes too
      noteCursor[kind] = { row: c.row, col: c.col };
      refreshSharedKeyboard(s);
      e.preventDefault();
      beginGesture();
      drag = { row: c.row, startCol: c.col, curCol: c.col };
      try { grid.setPointerCapture(e.pointerId); } catch (x) {}
      paint(c.row, c.col, c.col);
    });
    grid.addEventListener('pointermove', e => {
      if (!drag) return;
      const c = cellAt(e); if (!c || c.col === drag.curCol) return;
      drag.curCol = c.col;
      paint(drag.row, Math.min(drag.startCol, drag.curCol), Math.max(drag.startCol, drag.curCol));
    });
    grid.addEventListener('pointerup', () => {
      if (!drag) return;
      clearPaint();
      const a = Math.min(drag.startCol, drag.curCol), b = Math.max(drag.startCol, drag.curCol), len = b - a + 1, row = drag.row;
      drag = null;
      if (len === 1 && arr[a] && arr[a].r === row) { arr[a] = null; } // click an existing note → remove it
      else { notesClearRange(arr, a, a + len); arr[a] = { r: row, len }; preview(s, row); }
      noteCursor[kind] = { row, col: Math.min(totalSteps(s) - 1, a + len) };
      endGesture();
      const fresh = buildNoteGrid(s, kind); const sl = grid.scrollLeft; grid.replaceWith(fresh); fresh.scrollLeft = sl;
      refreshSharedKeyboard(s);
      saveSong();
    });
    grid.addEventListener('pointercancel', () => { clearPaint(); if (drag) { drag = null; dropState(); } });
  }
  function buildBassGrid(s) { return buildNoteGrid(s, 'bass'); }
  function buildLeadGrid(s) { return buildNoteGrid(s, 'lead'); }

  function buildDrumGrid(s) {
    const grid = el('div', 'seq-grid drum-grid');
    const cols = totalSteps(s), spb = stepsPerBar(s);
    grid.style.setProperty('--cols', cols);
    DRUM_ROWS.forEach(r => {
      const rowEl = el('div', 'seq-row');
      rowEl.appendChild(el('span', 'seq-row-label', r.label));
      for (let c = 0; c < cols; c++) {
        const v0 = drumVal(s.drums[r.key][c]);
        let cls = 'seq-cell' + cellMarks(c, s.subdiv, spb)
          + (v0 ? ' on' : '') + (v0 === 2 ? ' accent' : v0 === 3 ? ' ghost' : '');
        if (activePadMode === 'drums' && drumCursor.key === r.key && drumCursor.col === c) cls += ' cursor-cell';
        const cell = el('button', cls);
        cell.title = 'Tap cycles: hit → accent → ghost → off';
        cell.addEventListener('click', () => {
          if (activePadMode !== 'drums') setActivePadMode('drums');
          drumCursor = { key: r.key, col: c };
          pushState();
          const nv = (drumVal(s.drums[r.key][c]) + 1) % 4; // off → hit → accent → ghost → off
          s.drums[r.key][c] = nv;
          cell.classList.toggle('on', nv > 0);
          cell.classList.toggle('accent', nv === 2);
          cell.classList.toggle('ghost', nv === 3);
          if (nv) previewDrum(s, r.key, DRUM_VELS[nv] || 1);
          refreshSharedKeyboard(s);
          saveSong();
        });
        rowEl.appendChild(cell);
      }
      grid.appendChild(rowEl);
    });
    grid.appendChild(el('div', 'seq-playhead'));
    return grid;
  }

  /* ---------------- sampler lane (port SXRATCH pad samples → playable grid) ----------------
   * Import the samples loaded in the SXRATCH sampler pads, transpose one on a
   * keyboard (with live preview), set a length, and add it as a custom row. On
   * the grid a row plays just like bass/lead: drag across cells to set how long
   * it sounds — it stops where the drag ends. */
  let portedSamples = [];                          // [{ id, name, buffer }] copied from the pads
  let smpSel = { sampleId: null, transpose: 0, len: 2 }; // current builder selection
  const noteLabel = midi => NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  const findPorted = id => portedSamples.find(p => p.id === id);

  function addPortedSample(name, buffer, preferredId) {
    if (!buffer) return null;
    const safe = (preferredId || name || 'sample').replace(/[^\w.-]+/g, '-').slice(0, 42);
    let id = safe || 'sample';
    let n = 2;
    while (findPorted(id)) id = `${safe}-${n++}`;
    const rec = { id, name: name || id, buffer };
    portedSamples.push(rec);
    smpSel.sampleId = rec.id;
    saveSample(rec.id, rec.name, buffer).catch(() => {}); // persist across reloads
    return rec;
  }

  function portFromPads() {
    const sampler = _getSampler();
    if (!sampler || !sampler.slots) { _toast('Sampler unavailable.'); return; }
    let n = 0;
    sampler.slots.forEach((slot, i) => {
      if (!slot || !slot.buffer) return;
      const id = slot.name || ('Pad ' + (i + 1));
      const rec = { id, name: id, buffer: slot.buffer };
      const idx = portedSamples.findIndex(p => p.id === id);
      if (idx >= 0) portedSamples[idx] = rec; else portedSamples.push(rec);
      saveSample(id, id, slot.buffer).catch(() => {}); // persist across reloads
      n++;
    });
    if (!n) { _toast('No samples in the pads — load some on the SXRATCH sampler first.'); return; }
    if (!findPorted(smpSel.sampleId)) smpSel.sampleId = portedSamples[0].id;
    _toast(`Imported ${n} sample(s) from the pads.`);
    renderEditor();
  }

  /** Rehydrate persisted sampler slices from IndexedDB (⚠ rows resolve). */
  async function restorePortedSamples() {
    try {
      const stored = await loadAllSamples();
      if (!stored.length) return;
      const ac = _getCtx();
      let restored = 0;
      for (const rec of stored) {
        if (findPorted(rec.id) || !rec.channels?.length) continue;
        const buf = ac.createBuffer(rec.channels.length, rec.channels[0].length, rec.sampleRate || ac.sampleRate);
        rec.channels.forEach((ch, c) => buf.getChannelData(c).set(ch));
        portedSamples.push({ id: rec.id, name: rec.name || rec.id, buffer: buf });
        restored++;
      }
      if (restored) {
        if (!smpSel.sampleId || !findPorted(smpSel.sampleId)) smpSel.sampleId = portedSamples[0].id;
        renderEditor();
        _toast(`${restored} sampler slice(s) restored.`);
      }
    } catch (e) { console.warn('sample restore failed', e); }
  }

  function makeGeneratedSample(name, seconds, draw) {
    const ac = _getCtx();
    const sr = ac.sampleRate || 44100;
    const len = Math.max(1, Math.floor(seconds * sr));
    const buf = ac.createBuffer(1, len, sr);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = draw(i / sr, i / len);
    addPortedSample(name, buf, `starter-${name.toLowerCase().replace(/[^\w]+/g, '-')}`);
  }

  function loadStarterSamples() {
    // Seeded so the starter kit is the same kit in every session — these end
    // up in renders via sampler rows, and the render cache assumes the audio
    // for a given song is stable.
    const snareRnd = mulberry32(0x51A2E), hatRnd = mulberry32(0xBA7);
    makeGeneratedSample('Starter Kick', 0.48, (t, p) => Math.sin(2 * Math.PI * (94 - p * 52) * t) * Math.exp(-7.2 * p));
    makeGeneratedSample('Starter Snare', 0.38, (t, p) => ((snareRnd() * 2 - 1) * Math.exp(-10 * p) * 0.7) + Math.sin(2 * Math.PI * 186 * t) * Math.exp(-12 * p) * 0.25);
    makeGeneratedSample('Starter Hat', 0.18, (t, p) => (hatRnd() * 2 - 1) * Math.exp(-18 * p) * (p > 0.04 ? 0.55 : 0.2));
    makeGeneratedSample('Starter Bass Stab', 0.72, (t, p) => {
      const env = Math.min(1, p * 24) * Math.exp(-2.4 * p);
      return (Math.sin(2 * Math.PI * 55 * t) + 0.32 * Math.sin(2 * Math.PI * 110 * t)) * env * 0.55;
    });
    _toast('Loaded a built-in starter sampler kit.');
    renderEditor();
  }

  async function importSamplerFile(file, s) {
    if (!file) return;
    try {
      const ac = _getCtx();
      const ab = await file.arrayBuffer();
      const buffer = await ac.decodeAudioData(ab.slice(0));
      addPortedSample(file.name.replace(/\.[^.]+$/, ''), buffer, `file-${Date.now()}`);
      _toast(`Imported sample: ${file.name}`);
      renderEditor();
      if (s) refreshSharedKeyboard(s);
    } catch (e) {
      console.warn('sample import failed', e);
      _toast('Could not decode that sample file.');
    }
  }

  // Pitch a buffer by `transpose` semitones and gate it to `durSec` (with a tiny
  // fade so the hard stop doesn't click).
  function playSampleBuffer(ctx, dest, buffer, transpose, durSec, at, gain = 0.95) {
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.playbackRate.value = Math.pow(2, transpose / 12);
    const g = ctx.createGain();
    const end = at + Math.max(0.03, durSec);
    g.gain.setValueAtTime(gain, at);
    g.gain.setValueAtTime(gain, Math.max(at + 0.001, end - 0.012));
    g.gain.linearRampToValueAtTime(0.0001, end);
    src.connect(g).connect(dest);
    src.start(at);
    src.stop(end + 0.03);
    return src;
  }
  function previewSampleConfig(s) {
    const samp = findPorted(smpSel.sampleId); if (!samp) return;
    const ac = _getCtx();
    playSampleBuffer(ac, pvOut(), samp.buffer, smpSel.transpose, Math.max(1, smpSel.len) * stepSec(s), ac.currentTime + 0.02);
  }
  function previewRow(s, row, len) {
    const samp = findPorted(row.sampleId); if (!samp) return;
    const ac = _getCtx();
    playSampleBuffer(ac, pvOut(), samp.buffer, row.transpose, Math.max(1, len) * stepSec(s), ac.currentTime + 0.02);
  }

  function buildSamplerConfig(s) {
    const wrap = el('div'); wrap.id = 'sampler-config-body';
    const tools = el('div', 'lane-tools samp-tools');

    const imp = el('button', 'btn btn-mini', '⤓ Import from pads');
    imp.title = 'Copy the samples currently loaded in the SXRATCH sampler pads';
    imp.addEventListener('click', portFromPads);
    tools.appendChild(imp);

    const fileInput = el('input');
    fileInput.type = 'file';
    fileInput.accept = 'audio/*';
    fileInput.hidden = true;
    fileInput.addEventListener('change', () => {
      importSamplerFile(fileInput.files && fileInput.files[0], s);
      fileInput.value = '';
    });
    const fileBtn = el('button', 'btn btn-mini', 'Import file');
    fileBtn.type = 'button';
    fileBtn.title = 'Load an audio file directly into the PAD sampler lane';
    fileBtn.addEventListener('click', () => fileInput.click());
    tools.append(fileBtn, fileInput);

    const starter = el('button', 'btn btn-mini', 'Starter kit');
    starter.type = 'button';
    starter.title = 'Generate a built-in kick, snare, hat, and bass stab so the sampler lane works immediately';
    starter.addEventListener('click', loadStarterSamples);
    tools.appendChild(starter);

    const sel = el('select', 'samp-pick');
    if (!portedSamples.length) { sel.appendChild(opt('', 'No samples imported', true)); sel.disabled = true; }
    else {
      if (!findPorted(smpSel.sampleId)) smpSel.sampleId = portedSamples[0].id;
      portedSamples.forEach(p => sel.appendChild(opt(p.id, p.name, p.id === smpSel.sampleId)));
    }
    sel.addEventListener('change', () => { smpSel.sampleId = sel.value; previewSampleConfig(s); });
    tools.appendChild(labelWrap('Sample', sel));

    const lenIn = el('input'); lenIn.type = 'number'; lenIn.min = 1; lenIn.max = 32; lenIn.value = smpSel.len; lenIn.className = 'bars-input';
    lenIn.addEventListener('change', () => { smpSel.len = Math.max(1, Math.min(32, parseInt(lenIn.value, 10) || 1)); });
    tools.appendChild(labelWrap('Length (steps)', lenIn));

    tools.appendChild(el('span', 'hint', 'Key: ' + noteLabel(60 + smpSel.transpose) + (smpSel.transpose ? ` (${smpSel.transpose > 0 ? '+' : ''}${smpSel.transpose} st)` : ' · original') + ' · use shared keyboard'));

    const hear = el('button', 'btn btn-mini', '▶ Hear'); hear.disabled = !portedSamples.length;
    hear.addEventListener('click', () => previewSampleConfig(s));
    tools.appendChild(hear);

    const add = el('button', 'btn btn-mini btn-primary', '+ Add row'); add.disabled = !portedSamples.length;
    add.addEventListener('click', () => addSamplerRow(s));
    tools.appendChild(add);

    wrap.append(tools);
    return wrap;
  }
  function refreshSamplerConfig(s) {
    const body = document.getElementById('sampler-config-body');
    if (!body) { renderEditor(); return; }
    const oldKbd = body.querySelector('.chord-kbd'); const ks = oldKbd ? oldKbd.scrollLeft : null;
    const fresh = buildSamplerConfig(s);
    body.replaceWith(fresh);
    const nk = fresh.querySelector('.chord-kbd'); if (nk && ks != null) { nk.scrollLeft = ks; nk.dataset.scrolled = '1'; }
  }

  function addSamplerRow(s) {
    const samp = findPorted(smpSel.sampleId);
    if (!samp) { _toast('Import and pick a sample first.'); return; }
    pushState();
    s.samplerRows = s.samplerRows || [];
    s.samplerRows.push({ id: ++idc, sampleId: smpSel.sampleId, name: samp.name, transpose: smpSel.transpose, defaultLen: Math.max(1, smpSel.len), placements: new Array(totalSteps(s)).fill(null) });
    renderEditor(); saveSong();
  }

  // Per-step coverage for one row's placements (null | { start }).
  function samplerCoverage(arr, cols) {
    const cov = new Array(cols).fill(null);
    for (let i = 0; i < cols; i++) { const n = arr[i]; if (n) for (let k = 0; k < n.len && i + k < cols; k++) if (!cov[i + k]) cov[i + k] = { start: k === 0 }; }
    return cov;
  }
  function buildSamplerGrid(s) {
    s.samplerRows = s.samplerRows || [];
    if (!s.samplerRows.length) return el('div', 'samp-empty hint', 'No sample rows yet — import from pads, import an audio file, or load the starter kit, then add a row.');
    const grid = el('div', 'seq-grid sampler-grid');
    const cols = totalSteps(s), spb = stepsPerBar(s);
    grid.style.setProperty('--cols', cols);
    s.samplerRows.forEach(row => {
      const rowEl = el('div', 'seq-row');
      const label = el('span', 'seq-row-label samp-row-label');
      const missing = !findPorted(row.sampleId);
      label.append(el('span', 'samp-row-name', (row.name || 'sample') + ' · ' + noteLabel(60 + row.transpose) + (missing ? ' ⚠' : '')));
      const rm = el('button', 'samp-row-x', '×'); rm.title = 'Remove row';
      rm.addEventListener('click', (e) => { e.stopPropagation(); pushState(); s.samplerRows = s.samplerRows.filter(r => r !== row); renderEditor(); saveSong(); });
      label.appendChild(rm);
      rowEl.appendChild(label);
      const cov = samplerCoverage(row.placements, cols);
      for (let c = 0; c < cols; c++) {
        let cls = 'seq-cell' + cellMarks(c, s.subdiv, spb);
        const cv = cov[c]; if (cv) cls += cv.start ? ' on' : ' on tied';
        const cell = el('button', cls); cell.dataset.rowid = row.id; cell.dataset.col = c;
        rowEl.appendChild(cell);
      }
      grid.appendChild(rowEl);
    });
    grid.appendChild(el('div', 'seq-playhead'));
    attachSamplerDrag(grid, s);
    return grid;
  }
  function attachSamplerDrag(grid, s) {
    const cellAt = e => {
      let cell = e.target && e.target.closest ? e.target.closest('.seq-cell') : null;
      if (!cell || !grid.contains(cell)) { const t = document.elementFromPoint(e.clientX, e.clientY); cell = t && t.closest ? t.closest('.seq-cell') : null; }
      return (cell && grid.contains(cell)) ? { rowid: +cell.dataset.rowid, col: +cell.dataset.col } : null;
    };
    const paint = (rowid, a, b) => grid.querySelectorAll('.seq-cell').forEach(c => c.classList.toggle('drag', +c.dataset.rowid === rowid && +c.dataset.col >= a && +c.dataset.col <= b));
    const clearPaint = () => grid.querySelectorAll('.seq-cell.drag').forEach(c => c.classList.remove('drag'));
    let drag = null;
    grid.addEventListener('pointerdown', e => {
      const c = cellAt(e); if (!c) return; e.preventDefault();
      // setActivePadMode, not a raw assignment: the raw write left the lane
      // focus classes pointing at the previous lane, and on narrow layouts
      // `.song-lane:not(.active-lane)` is display:none — i.e. the lane being
      // dragged could hide itself mid-gesture. (setActivePadMode already
      // repaints the keyboard dock, so no manual refresh here.)
      if (activePadMode !== 'sampler') setActivePadMode('sampler');
      beginGesture();
      drag = { rowid: c.rowid, startCol: c.col, curCol: c.col };
      try { grid.setPointerCapture(e.pointerId); } catch (x) {}
      paint(c.rowid, c.col, c.col);
    });
    grid.addEventListener('pointermove', e => {
      if (!drag) return;
      const c = cellAt(e); if (!c || c.rowid !== drag.rowid || c.col === drag.curCol) return;
      drag.curCol = c.col;
      paint(drag.rowid, Math.min(drag.startCol, drag.curCol), Math.max(drag.startCol, drag.curCol));
    });
    grid.addEventListener('pointerup', () => {
      if (!drag) return; clearPaint();
      const a = Math.min(drag.startCol, drag.curCol), b = Math.max(drag.startCol, drag.curCol), len = b - a + 1;
      const row = s.samplerRows.find(r => r.id === drag.rowid); drag = null;
      if (!row) { endGesture(); return; }
      if (len === 1 && row.placements[a]) { row.placements[a] = null; }       // click a placement to remove it
      else { notesClearRange(row.placements, a, a + len); row.placements[a] = { len }; previewRow(s, row, len); }
      endGesture();
      const fresh = buildSamplerGrid(s); const sl = grid.scrollLeft; grid.replaceWith(fresh); fresh.scrollLeft = sl;
      saveSong();
    });
    grid.addEventListener('pointercancel', () => { clearPaint(); if (drag) { drag = null; dropState(); } });
  }

  /* ---------------- structure ops ---------------- */
  function addSection(type, at = song.selected + 1) {
    pushState();
    const i = Math.max(0, Math.min(at, song.sections.length));
    song.sections.splice(i, 0, makeSection(type, song.sections[song.selected]));
    song.selected = i;
    render();
  }
  function duplicateSection(i) { pushState(); const copy = JSON.parse(JSON.stringify(song.sections[i])); copy.id = ++idc; song.sections.splice(i + 1, 0, copy); song.selected = i + 1; render(); }
  function removeSection(i) { pushState(); song.sections.splice(i, 1); if (song.selected >= song.sections.length) song.selected = song.sections.length - 1; render(); }
  function moveSection(i, dir) { const j = i + dir; if (j < 0 || j >= song.sections.length) return; pushState(); [song.sections[i], song.sections[j]] = [song.sections[j], song.sections[i]]; song.selected = j; render(); }

  /* ---------------- synthesis ---------------- */
  // All voices live in js/synth.js now (designed patches: unison/stereo pads &
  // strings, FM e-piano, drawbar organ, KS guitars/upright, layered drums).
  // These wrappers pick synth vs sampled per note and pass velocity through.

  /* ---------------- live previews (audition while building) ---------------- */
  let _pvMaster = null, _pvNoise = null;
  function pvOut() {
    const ac = _getCtx();
    if (!_pvMaster || _pvMaster.context !== ac) {
      // Peak-catcher on the preview bus: dense chords through the new voices
      // can sum hot, and previews bypass the deck master limiter.
      const catcher = ac.createDynamicsCompressor();
      catcher.threshold.value = -6; catcher.knee.value = 3; catcher.ratio.value = 14;
      catcher.attack.value = 0.001; catcher.release.value = 0.1;
      catcher.connect(ac.destination);
      _pvMaster = ac.createGain(); _pvMaster.gain.value = 0.9; _pvMaster.connect(catcher);
      _pvNoise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      _pvNoise.getChannelData(0).set(noiseData(ac.sampleRate, 1));
    }
    return _pvMaster;
  }
  function previewBass(s, row, vel = 1) { const ac = _getCtx(); voiceBass(ac, pvOut(), 36 + s.key + MAJOR[row], ac.currentTime + 0.02, 0.5, s.bassSound, vel, _pvNoise, patchFor(s, 'bass')); }
  function previewLead(s, row, vel = 1) { const ac = _getCtx(); voiceLead(ac, pvOut(), 72 + s.key + MAJOR[row], ac.currentTime + 0.02, 0.5, s.leadSound, vel, _pvNoise, patchFor(s, 'lead')); }
  function previewDrum(s, key, vel = 1) {
    const ac = _getCtx();
    voiceDrum(ac, pvOut(), key, ac.currentTime + 0.02, _pvNoise, s.drumKit || 'acoustic', vel);
  }

  /* ---- sampled-instrument routing ----
   * With the sampled engine on and the mapped GM instrument decoded, play a real
   * multisample; otherwise fall back to the synth.js patch. The synth path is
   * always the default and the offline / no-network fallback. `vel` carries the
   * humanized per-step velocity into both paths. */
  function voiceChord(oc, dest, notes, at, dur, sound, vel = 1, noise = null, patch = null, step = 0) {
    if (useSamples && sampleBank) {
      const prog = GM_PROGRAMS.chord[sound];
      if (prog && notes.every(m => sampleBank.has(prog, m))) { notes.forEach(m => sampleBank.play(prog, m, dest, at, dur, 0.8 * vel)); return; }
    }
    notes.forEach((m, i) => playInstrument('chord', sound, oc, dest, m, at, dur, vel, { noise, ndx: i, count: notes.length, patch, step }));
  }
  function voiceBass(oc, dest, m, at, dur, sound, vel = 1, noise = null, patch = null, step = 0) {
    if (useSamples && sampleBank) { const prog = GM_PROGRAMS.bass[sound]; if (prog && sampleBank.has(prog, m)) { sampleBank.play(prog, m, dest, at, dur, 0.85 * vel); return; } }
    playInstrument('bass', sound, oc, dest, m, at, dur, vel, { noise, patch, step });
  }
  function voiceLead(oc, dest, m, at, dur, sound, vel = 1, noise = null, patch = null, step = 0) {
    if (useSamples && sampleBank) { const prog = GM_PROGRAMS.lead[sound]; if (prog && sampleBank.has(prog, m)) { sampleBank.play(prog, m, dest, at, dur, 0.8 * vel); return; } }
    playInstrument('lead', sound, oc, dest, m, at, dur, vel, { noise, patch, step });
  }
  // Drums: sampled kit one-shot when loaded, else the synth.js drum sample
  // (rendered once per kit/key, so each hit is a single BufferSource).
  function voiceDrum(oc, dest, key, at, noise, kit, vel = 1, variant = 0) {
    if (useSamples && sampleBank && sampleBank.hasDrum(kit, key)) {
      let out = dest;
      if (vel !== 1) { const g = oc.createGain(); g.gain.value = vel; g.connect(dest); out = g; }
      sampleBank.playDrum(kit, key, out, at, 0.7);
      return null;
    }
    return playDrumHit(oc, dest, kit, key, at, vel, variant);
  }

  // Per GM program, the exact MIDI notes a set of sections plays — so we decode
  // only those before an offline render (not all 88 notes of each instrument).
  function sampleNeeds(sections) {
    const needs = new Map();
    const add = (prog, midi) => { if (!prog) return; if (!needs.has(prog)) needs.set(prog, new Set()); needs.get(prog).add(midi); };
    sections.forEach(s => {
      s.chords.forEach(ch => { if (ch) ch.notes.forEach(m => add(GM_PROGRAMS.chord[s.chordSound], m)); });
      s.bass.forEach(n => { if (n) add(GM_PROGRAMS.bass[s.bassSound], 36 + s.key + MAJOR[n.r]); });
      (s.lead || []).forEach(n => { if (n) add(GM_PROGRAMS.lead[s.leadSound], 72 + s.key + MAJOR[n.r]); });
    });
    return needs;
  }
  async function ensureSamples(sections) {
    if (!useSamples || !sampleBank) return { needed: 0, loaded: 0 };
    const needs = sampleNeeds(sections);
    const drumKits = new Set();
    sections.forEach(s => { if (DRUM_ROWS.some(r => s.drums[r.key].some(Boolean))) drumKits.add(s.drumKit || 'acoustic'); });
    await Promise.all([
      ...[...needs].map(([prog, midis]) => sampleBank.ensure(prog, [...midis]).catch(() => {})),
      ...[...drumKits].map(kit => sampleBank.loadDrumKit(kit).catch(() => {})),
    ]);
    // Per-note failures are swallowed above so one bad fetch can't sink the
    // batch — report real coverage so callers can tell "ready" from "nothing
    // actually loaded" (the status UI was showing ✓ even fully offline).
    let needed = 0, loaded = 0;
    needs.forEach((midis, prog) => midis.forEach(m => { needed++; if (sampleBank.has(prog, m)) loaded++; }));
    return { needed, loaded };
  }

  /* ---------------- synth patches ----------------
   * A lane's sound is a factory patch id; the synth editor stores only the
   * parameters the user actually changed, under `section.patches['<lane>:<sound>']`.
   * Living inside the section object means patches ride the existing undo/redo,
   * autosave, project slots, JSON import/export and render-cache keying for free,
   * and a song with no `patches` key renders exactly as it did before the editor. */
  const PATCH_FAMILY = { chords: 'chord', bass: 'bass', lead: 'lead' };

  function trackSound(s, track) {
    return track === 'chords' ? s.chordSound : track === 'bass' ? s.bassSound : track === 'lead' ? s.leadSound : null;
  }
  function patchKey(s, track) {
    const fam = PATCH_FAMILY[track];
    return fam ? `${track}:${trackSound(s, track)}` : null;
  }
  /** Sparse override object for a lane's current sound (created on demand). */
  function patchOverrides(s, track, create = false) {
    const key = patchKey(s, track);
    if (!key) return null;
    if (!s.patches || typeof s.patches !== 'object') { if (!create) return null; s.patches = {}; }
    if (!s.patches[key]) { if (!create) return null; s.patches[key] = {}; }
    return s.patches[key];
  }
  /** Fully resolved (factory ⊕ overrides, clamped) patch for a lane. */
  function patchFor(s, track) {
    const fam = PATCH_FAMILY[track];
    if (!fam) return null;
    return resolvePatch(fam, trackSound(s, track), (s.patches || {})[patchKey(s, track)]);
  }
  /** True when the user has edited this lane's current sound away from factory. */
  function patchIsEdited(s, track) {
    const ov = (s.patches || {})[patchKey(s, track)];
    return !!ov && Object.keys(ov).length > 0;
  }
  /** Drop empty override objects so an untouched song serializes with no `patches` at all. */
  function prunePatches(s) {
    if (!s.patches) return;
    for (const k of Object.keys(s.patches)) {
      if (!s.patches[k] || !Object.keys(s.patches[k]).length) delete s.patches[k];
    }
    if (!Object.keys(s.patches).length) delete s.patches;
  }

  function createTrackBus(oc, master, s, track, soloActive) {
    const mix = mixFor(s, track);
    const input = oc.createGain();
    const tone = oc.createBiquadFilter();
    tone.type = 'lowpass';
    // Brighter curve than before: 0.5 ≈ 9 kHz, defaults (~0.7) ≈ 14 kHz, 1 = open.
    tone.frequency.value = 180 + Math.pow(Math.max(0, Math.min(1, mix.tone)), 1.25) * 21800;
    tone.Q.value = 0.5 + (1 - mix.tone) * 0.9;

    // Patch ensemble chorus (pad/strings/e-piano/organ width) — an editable
    // patch parameter, so it follows whatever the synth editor is set to.
    let chain = tone;
    const patch = patchFor(s, track);
    const chorusAmt = patch ? (patch.params.chorus || 0) : 0;
    if (chorusAmt > 0.02) {
      const ch = makeChorus(oc, { mix: chorusAmt });
      chain.connect(ch.in);
      chain = ch.out;
    }

    let post = chain;
    if (oc.createStereoPanner) {
      const pan = oc.createStereoPanner();
      pan.pan.value = Math.max(-1, Math.min(1, mix.pan || 0));
      chain.connect(pan);
      post = pan;
    }

    const gain = oc.createGain();
    const silent = !!mix.mute || (soloActive && !mix.solo);
    gain.gain.value = silent ? 0 : Math.max(0, Math.min(1.2, mix.volume));
    input.connect(tone);
    post.connect(gain);
    gain.connect(master);

    if (!silent && mix.echo > 0.005) {
      // Tempo-synced ping-pong (dotted eighth) with darkening repeats —
      // follows the section's own tempo when it overrides the song.
      const echo = makeEchoSend(oc, {
        time: secPerQuarter(s) * 0.75,
        fb: Math.min(0.6, 0.16 + mix.echo * 0.45),
        tone: 2600, hp: 170,
      });
      const wet = oc.createGain();
      wet.gain.value = mix.echo * 0.4;
      gain.connect(echo.in);
      echo.out.connect(wet);
      wet.connect(master);
    }

    if (!silent && mix.reverb > 0.005) {
      const verb = makeReverbSend(oc, {
        seconds: 1.1 + mix.reverb * 1.4,
        decay: 2.6 + (1 - mix.reverb) * 1.0,
        predelay: 0.018,
        damp: 0.5,
      });
      const wet = oc.createGain();
      wet.gain.value = mix.reverb * 0.32;
      gain.connect(verb.in);
      verb.out.connect(wet);
      wet.connect(master);
    }

    return { input };
  }

  function createSectionBuses(oc, master, s) {
    ensureMix(s);
    const soloActive = TRACK_KEYS.some(k => mixFor(s, k).solo);
    return Object.fromEntries(TRACK_KEYS.map(k => [k, createTrackBus(oc, master, s, k, soloActive)]));
  }

  // Humanized per-step velocity: downbeats lean in, offbeats sit back, plus a
  // deterministic ±4% jitter (seeded per section+lane) so lines breathe
  // without ever rendering two different results for the same song.
  function stepVel(s, laneSeed, c) {
    const spb = stepsPerBar(s);
    const base = c % spb === 0 ? 1.07 : c % s.subdiv === 0 ? 1 : 0.93;
    const jit = 1 + (stepRand((s.id * 131071) ^ laneSeed, c) - 0.5) * 0.08;
    return Math.max(0.7, Math.min(1.15, base * jit));
  }

  function renderSectionInto(oc, master, noise, s, t) {
    const bus = createSectionBuses(oc, master, s);
    const ss = stepSec(s);
    // Swing: every 2nd step is delayed by swing × step (MPC-style shuffle),
    // applied to every lane so the pocket stays coherent.
    const sw = (s.swing || 0) * ss;
    // Timing humanize: a deterministic per-note micro-offset (±ms, seeded per
    // section/lane/step — identical songs always render identically). Melodic
    // lanes get the full amount; drums half, so the pocket stays anchored.
    const humanSec = (song.humanize || 0) / 1000;
    const hOff = (laneSeed, c) => humanSec
      ? (stepRand((s.id * 92821) ^ (laneSeed * 613), c) * 2 - 1) * humanSec
      : 0;
    const tAt = (c) => t + c * ss + (c % 2 === 1 ? sw : 0);
    // Humanized note time: symmetric ± offset, clamped only at the render start.
    const hAt = (laneSeed, c, scale = 1) => Math.max(0, tAt(c) + hOff(laneSeed, c) * scale);
    // Resolve each lane's patch once per section, not per note.
    const pChords = patchFor(s, 'chords'), pBass = patchFor(s, 'bass'), pLead = patchFor(s, 'lead');
    s.chords.forEach((ch, c) => { if (ch) voiceChord(oc, bus.chords.input, ch.notes, hAt(1, c), ss * ch.len, s.chordSound, stepVel(s, 1, c), noise, pChords, c); });
    s.bass.forEach((n, c) => { if (n) voiceBass(oc, bus.bass.input, 36 + s.key + MAJOR[n.r], hAt(2, c), ss * n.len, s.bassSound, stepVel(s, 2, c), noise, pBass, c); });
    (s.lead || []).forEach((n, c) => { if (n) voiceLead(oc, bus.lead.input, 72 + s.key + MAJOR[n.r], hAt(3, c), ss * n.len, s.leadSound, stepVel(s, 3, c), noise, pLead, c); });
    const kit = s.drumKit || 'acoustic';
    // Collected so the open hats can be choked by the closed ones below.
    const openHits = [], closedTimes = [];
    DRUM_ROWS.forEach((r, ri) => s.drums[r.key].forEach((on, c) => {
      const v = drumVal(on);
      if (!v) return;
      const jit = 1 + (stepRand((s.id * 524287) ^ (ri + 11), c) - 0.5) * 0.07;
      // Round-robin take, chosen from the step so the render stays byte-stable
      // and the content-keyed render cache stays valid.
      const variant = (stepRand((s.id * 8191) ^ (ri * 7919), c) * 4) | 0;
      const t = hAt(4 + ri, c, 0.5);
      const hit = voiceDrum(oc, bus.drums.input, r.key, t, noise, kit, (DRUM_VELS[v] || 1) * jit, variant);
      if (r.key === 'open' && hit) openHits.push({ at: t, hit });
      if (r.key === 'hat') closedTimes.push(t);
    }));
    // A real hi-hat cannot ring open through a closed hit — fade, don't cut.
    chokeSchedule(openHits.map(o => o.at), closedTimes).forEach((cut, i) => {
      if (cut == null) return;
      const h = openHits[i].hit;
      if (cut < h.until) h.gain.gain.setTargetAtTime(0.0001, cut, 0.008);
    });
    (s.samplerRows || []).forEach(row => {
      const samp = findPorted(row.sampleId); if (!samp) return;
      row.placements.forEach((n, c) => { if (n) playSampleBuffer(oc, bus.sampler.input, samp.buffer, row.transpose, n.len * ss, tAt(c)); });
    });
  }

  async function renderSections(sections) {
    if (!sections.length) return null;
    // Memoize the offline render: Preview / → Deck / WAV re-rendered the whole
    // song every click even when nothing changed. Key on engine + tempo + content.
    const key = (useSamples ? 's|' : 'y|') + song.bpm + '|h' + (song.humanize || 0) + '|' + JSON.stringify(sections);
    const hit = renderCache.get(key);
    if (hit) { renderCache.delete(key); renderCache.set(key, hit); return hit; } // refresh LRU order
    await ensureSamples(sections); // decode any sampled instruments the song uses
    const sr = _getCtx().sampleRate;
    // 2.2 s tail: the new voices have real release tails and reverbs ring out.
    const total = sections.reduce((a, s) => a + sectionSec(s), 0) + 2.2;
    const oc = new OfflineAudioContext(2, Math.ceil(total * sr), sr);
    // Master: gentle 2.5:1 glue only — the old default-settings compressor
    // (−24 dB / 12:1) crushed every render. Peak safety happens after the
    // render in masterFinalize (loudness normalize + look-ahead limiter).
    const master = oc.createGain(); master.gain.value = 0.9;
    const glue = glueCompressor(oc); master.connect(glue); glue.connect(oc.destination);
    // Seeded, not Math.random(): the render cache is content-keyed, so a
    // cache hit and a fresh render have to be the SAME take.
    const noise = oc.createBuffer(1, sr, sr);
    noise.getChannelData(0).set(noiseData(sr, 1));
    let t = 0;
    sections.forEach(s => { renderSectionInto(oc, master, noise, s, t); t += sectionSec(s); });
    const buffer = await oc.startRendering();
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    masterFinalize(chans, sr); // consistent loudness + true-peak ceiling, in place
    renderCache.set(key, buffer);
    // Cap the cache by total AUDIO SECONDS, not entry count — four 4-minute
    // stereo renders would be ~300 MB; ~240 s ≈ 40 MB worst case.
    const CACHE_BUDGET_SEC = 240;
    let totalSec = 0;
    for (const buf of renderCache.values()) totalSec += buf.duration;
    for (const k of renderCache.keys()) {
      if (totalSec <= CACHE_BUDGET_SEC || renderCache.size <= 1) break;
      totalSec -= renderCache.get(k).duration;
      renderCache.delete(k); // Map iterates in insertion order = LRU-first
    }
    return buffer;
  }

  /* ---------------- per-section play + playhead ---------------- */
  function toggleSectionPlay() {
    if (sectionPlay) { stopSectionPlay(); return; }
    const s = song.sections[song.selected];
    const btn = $('#btn-song-play-sec');
    btn.disabled = true; btn.textContent = '⏳ Rendering…';
    renderSections([s]).then(buf => {
      btn.disabled = false;
      if (!buf) { btn.textContent = '▶ Play section'; return; }
      const ac = _getCtx();
      const src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination);
      const dur = sectionSec(s);
      if (loopSection) { src.loop = true; src.loopStart = 0; src.loopEnd = dur; } // loop the musical part (trim tail)
      let startAt = ac.currentTime + 0.06;
      if (countInOn) {
        // One bar of clicks at the section's own meter, then the music.
        if (!padMetro) padMetro = createMetronome(ac, pvOut());
        const t0 = padMetro.start({
          bpm: 60 / unitSec(s),
          beatsPerBar: s.ts.num,
          maxBeats: s.ts.num,
          startAt: ac.currentTime + 0.12,
        });
        startAt = t0 + barSec(s);
      }
      src.start(startAt);
      const chordGrid = $('#song-editor').querySelector('.chord-grid');
      const nowName = $('#song-editor').querySelector('.chord-now');
      sectionPlay = { src, startAt, dur, s, chordGrid, nowName, lastChordStart: -2, raf: null, loop: loopSection };
      src.onended = () => { if (sectionPlay && sectionPlay.src === src) stopSectionPlay(); };
      btn.textContent = '⏹ Stop section';
      runPlayhead();
    }).catch(e => { console.warn(e); btn.disabled = false; btn.textContent = '▶ Play section'; _toast('Could not render the section.'); });
  }

  function runPlayhead() {
    const ac = _getCtx();
    const grids = [...$('#song-editor').querySelectorAll('.seq-grid')].map(g => ({ g, h: g.querySelector('.seq-playhead') }));
    // Follow by SCROLLING the grid the cursor is in, keeping it comfortably
    // inside the viewport. Uses the grid's own resolved cell pitch rather
    // than a JS constant, so it tracks any CSS/breakpoint change for free.
    function follow(grid, col) {
      const cs = getComputedStyle(grid);
      const cell = parseFloat(cs.getPropertyValue('--cell')) || 18;
      const gap = parseFloat(cs.getPropertyValue('--gap')) || 3;
      const lbl = parseFloat(cs.getPropertyValue('--lblw')) || 54;
      const x = lbl + gap + col * (cell + gap);
      const sl = grid.scrollLeft, w = grid.clientWidth;
      if (x < sl + 40) grid.scrollLeft = Math.max(0, x - 40);
      else if (x > sl + w - 40) grid.scrollLeft = x - w + 40;
    }
    (function loop() {
      const sp = sectionPlay; if (!sp) return;
      let elapsed = ac.currentTime - sp.startAt;
      if (elapsed >= 0) {
        if (sp.loop) elapsed = elapsed % sp.dur;
        else if (elapsed >= sp.dur) { stopSectionPlay(); return; }
        const { col } = playCol(elapsed, stepSec(sp.s), 0, totalSteps(sp.s));
        grids.forEach(({ g, h }) => {
          if (h) { g.style.setProperty('--play-col', col.toFixed(3)); h.style.display = 'block'; }
          follow(g, col);
        });
        const step = Math.min(totalSteps(sp.s) - 1, Math.floor(elapsed / stepSec(sp.s)));
        const start = chordStartCovering(sp.s, step);
        if (start !== sp.lastChordStart) {
          if (sp.chordGrid) sp.chordGrid.querySelectorAll('.seq-cell.playing').forEach(c => c.classList.remove('playing'));
          if (start != null && sp.chordGrid) {
            const ch = sp.s.chords[start];
            for (let k = 0; k < ch.len; k++) { const cell = sp.chordGrid.querySelector('.seq-cell[data-col="' + (start + k) + '"]'); if (cell) cell.classList.add('playing'); }
            if (sp.nowName) sp.nowName.textContent = ch.name;
          } else if (sp.nowName) sp.nowName.textContent = '';
          sp.lastChordStart = start;
        }
      }
      sp.raf = requestAnimationFrame(loop);
    })();
  }

  function stopSectionPlay() {
    padMetro?.stop(); // cancel a pending count-in
    if (!sectionPlay) return;
    const sp = sectionPlay; sectionPlay = null;
    if (sp.raf) cancelAnimationFrame(sp.raf);
    try { sp.src.stop(); } catch (e) {}
    if (sp.chordGrid) sp.chordGrid.querySelectorAll('.seq-cell.playing').forEach(c => c.classList.remove('playing'));
    if (sp.nowName) sp.nowName.textContent = '';
    document.querySelectorAll('#song-editor .seq-playhead').forEach(h => { h.style.display = 'none'; });
    const btn = $('#btn-song-play-sec'); if (btn) { btn.textContent = '▶ Play section'; btn.disabled = false; }
  }

  /* ---------------- whole-song preview & apply ---------------- */
  function stopPreview() { playNodes.forEach(n => { try { n.stop(); } catch (e) {} }); playNodes = []; }
  async function preview() {
    stopPreview(); stopSectionPlay();
    const btn = $('#btn-song-preview'); btn.disabled = true; btn.textContent = '⏳ Rendering…';
    try {
      const buf = await renderSections(song.sections);
      btn.textContent = '▶ Preview song'; btn.disabled = false;
      if (!buf) return;
      previewedOnce = true;
      renderNextStep();
      const ac = _getCtx(); const src = ac.createBufferSource(); src.buffer = buf; src.connect(ac.destination); src.start(); playNodes.push(src);
    } catch (e) { console.warn(e); btn.textContent = '▶ Preview song'; btn.disabled = false; _toast('Could not render the song.'); }
  }
  const songLabel = () => `song · ${song.sections.length} sections · ${song.bpm} BPM`;

  // Render the whole song and load it onto a Sxratch deck (to scratch / mix).
  async function sendToDeck(deck) {
    const btn = $('#btn-song-deck' + deck); const txt = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳ Rendering…';
    try {
      const buf = await renderSections(song.sections);
      if (buf) {
        // Section-boundary cue positions (fractions of the rendered buffer,
        // which has a release tail beyond the musical length — see renderSections).
        const cues = [];
        let t = 0;
        song.sections.forEach(s => { cues.push(t / buf.duration); t += sectionSec(s); });
        // The deck beat grid needs ONE tempo: anchor it only when every
        // section shares it; with per-section overrides the deck auto-detects.
        const tempos = new Set(song.sections.map(sec => sec.bpm || song.bpm));
        _onUse(buf, songLabel(), deck, tempos.size === 1 ? [...tempos][0] : null, cues);
        _toast(`Loaded onto Deck ${deck} — sections are on hot cues 1–${Math.min(8, cues.length)}.`);
      }
    } catch (e) { console.warn(e); _toast('Could not render the song.'); }
    btn.textContent = txt; btn.disabled = false;
  }

  async function downloadSong() {
    const btn = $('#btn-song-dl'); const txt = btn.textContent;
    btn.disabled = true; btn.textContent = '⏳ Rendering…';
    try {
      const buf = await renderSections(song.sections);
      if (buf) {
        const url = URL.createObjectURL(bufferToWav(buf));
        const a = document.createElement('a'); a.href = url; a.download = 'sxratch-pad-song.wav'; a.click();
        setTimeout(() => URL.revokeObjectURL(url), 4000);
        _toast('Downloaded your song as WAV.');
      }
    } catch (e) { console.warn(e); _toast('Could not render the song.'); }
    btn.textContent = txt; btn.disabled = false;
  }

  function upgradePadShell(root) {
    if (!root || root.querySelector('.pad-workstation')) return;
    const meta = root.querySelector('.song-meta');
    const add = root.querySelector('.song-add');
    const timeline = root.querySelector('.song-timeline');
    const editor = root.querySelector('#song-editor');
    const duration = root.querySelector('#song-duration');
    if (!meta || !add || !timeline || !editor) return;

    const setButton = (sel, cls, html) => {
      const btn = root.querySelector(sel);
      if (!btn) return;
      btn.className = (btn.className + ' ' + cls).trim();
      btn.innerHTML = html;
    };
    setButton('#btn-song-preview', 'pad-transport-btn pad-play', '<span class="pad-transport-icon">▶</span><span>Preview</span>');
    setButton('#btn-song-preview-stop', 'pad-transport-btn pad-stop', '<span class="pad-transport-icon">■</span><span>Stop</span>');
    setButton('#btn-song-dl', 'pad-transport-btn', '<span class="pad-transport-icon">⇩</span><span>WAV</span>');
    setButton('#btn-song-deckA', 'pad-send', 'Send A');
    setButton('#btn-song-deckB', 'pad-send', 'Send B');
    setButton('#btn-song-export', 'pad-utility', 'Export');
    setButton('#btn-song-import', 'pad-utility', 'Import');
    setButton('#btn-song-undo', 'pad-utility', 'Undo');
    setButton('#btn-song-redo', 'pad-utility', 'Redo');
    setButton('#btn-song-projects', 'pad-utility', 'Projects');
    setButton('#btn-song-midi', 'pad-utility', 'MIDI');

    // ---- transport: six task zones, not one 14-item row ----
    // The old cluster declared 13 grid columns and received 14 children into a
    // 70px header, so it wrapped and clipped (measured: 139px of content in a
    // 70px row at 1280x800). Worse, the ordering came from the order of the
    // template string, so Play sat beside Import. Everything here is SONG
    // scope; per-section controls live on the section strip, per-track ones in
    // the inspector. Nodes are RE-PARENTED, never rebuilt, so every listener
    // wired in init() keeps working.
    const zone = (cls, label) => {
      const z = el('div', 'tp-zone ' + cls);
      if (label) z.appendChild(el('span', 'tp-zone-label', label));
      return z;
    };
    const grab = (sel) => meta.querySelector(sel) || root.querySelector(sel);

    const primary = zone('tp-primary');
    primary.append(grab('#btn-song-preview'), grab('#btn-song-preview-stop'));

    const tempo = zone('tp-tempo', 'Song tempo');
    const bpmLabel = meta.querySelector('label');
    if (bpmLabel) { bpmLabel.classList.add('pad-bpm-module'); tempo.appendChild(bpmLabel); }

    const sound = zone('tp-sound', 'Sound');
    // querySelectorAll: there are TWO .song-engine labels (Sound and Feel).
    // querySelector styled only the first, so Feel rendered as a bare label
    // in a row of chrome modules.
    meta.querySelectorAll('.song-engine').forEach(e => { e.classList.add('pad-engine-module'); sound.appendChild(e); });
    const status = grab('#song-engine-status');
    if (status) {
      status.classList.add('pad-engine-status');
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      sound.appendChild(status);
    }

    // The "what is happening right now" readout: idle it shows the song's
    // length, during playback the sounding section and position.
    const now = el('div', 'tp-now');
    const nowMain = el('div', 'tp-now-main'); nowMain.id = 'tp-now-main';
    if (duration) now.append(nowMain, duration); else now.append(nowMain);
    const nowBar = el('div', 'tp-now-bar'); nowBar.id = 'tp-now-bar';
    now.appendChild(nowBar);

    const out = zone('tp-out', 'Send to deck');
    out.append(grab('#btn-song-deckA'), grab('#btn-song-deckB'));

    // Everything that leaves the app or manages files goes behind one
    // disclosure — six utilities competing with Play for attention was the
    // main reason the header read as a bag of buttons.
    const more = el('details', 'pad-more');
    const moreSum = el('summary', 'pad-more-summary', '⋯ File');
    moreSum.title = 'Projects, export and import';
    const moreBody = el('div', 'pad-more-body');
    ['#btn-song-projects', '#btn-song-dl', '#btn-song-midi', '#btn-song-export', '#btn-song-import', '#song-import-file']
      .forEach(sel => { const n = grab(sel); if (n) moreBody.appendChild(n); });
    more.append(moreSum, moreBody);

    // Undo/redo are never hidden at any breakpoint: on a phone Ctrl+Z does
    // not exist, so hiding them removes the only way to take a mistake back.
    const history = zone('tp-history');
    history.append(grab('#btn-song-undo'), grab('#btn-song-redo'), more);

    meta.remove();
    const transport = el('header', 'pad-transport');
    transport.append(primary, tempo, sound, now, out, history);

    // ---- section rail ----
    const railHead = el('div', 'rail-head');
    railHead.append(el('span', 'label-sm', 'Song sections'));
    const addMenu = el('details', 'pad-add-menu');
    addMenu.open = true;
    const addSum = el('summary', 'pad-add-summary', '+ Add section');
    addMenu.append(addSum, add);
    // Replaces the static three-step <ol> (which had no CSS at all and
    // rendered as browser decimal markers): a live, state-derived prompt.
    const next = el('div', 'rail-next');
    next.id = 'song-nextstep';

    const rail = el('aside', 'pad-section-rail');
    rail.append(railHead, addMenu, timeline, next);

    // ---- arrangement + inspector ----
    editor.classList.add('bench-shell');
    const arrangement = el('section', 'pad-arrangement');
    arrangement.appendChild(editor);
    const inspector = el('aside', 'pad-inspector');
    inspector.id = 'song-inspector';
    const body = el('div', 'pad-body');
    body.append(rail, arrangement, inspector);

    const shell = el('div', 'pad-workstation');
    shell.append(transport, body);
    root.innerHTML = '';
    root.appendChild(shell);
  }

  /* ---------------- MIDI export ---------------- */
  // GM percussion notes for the kit rows (channel 10 / index 9).
  const GM_DRUM = { kick: 36, snare: 38, hat: 42, open: 46, crash: 49, tomH: 50, tomM: 47, tomL: 45 };
  const MIDI_DRUM_VELS = { 1: 88, 2: 114, 3: 46 };

  function buildMidiData() {
    const TPQ = 480;
    const tracks = {
      chords: { name: 'Chords', channel: 0, notes: [] },
      bass: { name: 'Bass', channel: 1, notes: [] },
      lead: { name: 'Lead', channel: 2, notes: [] },
      drums: { name: 'Drums', channel: 9, notes: [] },
    };
    const timeSigs = [], tempos = [];
    let tick = 0, lastSig = '', lastBpm = 0;
    song.sections.forEach(s => {
      const tps = TPQ * (4 / s.ts.den) / s.subdiv; // ticks per step
      const sw = (s.swing || 0) * tps;
      const tAt = c => Math.round(tick + c * tps + (c % 2 === 1 ? sw : 0));
      const sig = s.ts.num + '/' + s.ts.den;
      if (sig !== lastSig) { timeSigs.push({ tick: Math.round(tick), num: s.ts.num, den: s.ts.den }); lastSig = sig; }
      const bpm = s.bpm || song.bpm;
      if (bpm !== lastBpm) { tempos.push({ tick: Math.round(tick), bpm }); lastBpm = bpm; }
      s.chords.forEach((ch, c) => {
        if (ch) ch.notes.forEach(n => tracks.chords.notes.push({ tick: tAt(c), dur: Math.round(ch.len * tps), note: n, vel: 82 }));
      });
      s.bass.forEach((n, c) => {
        if (n) tracks.bass.notes.push({ tick: tAt(c), dur: Math.round(n.len * tps), note: 36 + s.key + MAJOR[n.r], vel: 92 });
      });
      (s.lead || []).forEach((n, c) => {
        if (n) tracks.lead.notes.push({ tick: tAt(c), dur: Math.round(n.len * tps), note: 72 + s.key + MAJOR[n.r], vel: 88 });
      });
      DRUM_ROWS.forEach(r => s.drums[r.key].forEach((on, c) => {
        const v = drumVal(on);
        if (!v) return;
        tracks.drums.notes.push({ tick: tAt(c), dur: Math.max(1, Math.round(tps * 0.5)), note: GM_DRUM[r.key], vel: MIDI_DRUM_VELS[v] || 88 });
      }));
      tick += totalSteps(s) * tps;
    });
    return {
      ticksPerQuarter: TPQ,
      tempoBpm: song.bpm,
      tempos,
      timeSigs,
      tracks: Object.values(tracks).filter(t => t.notes.length),
    };
  }

  function downloadMidi() {
    if (!song.sections.length) return;
    try {
      const bytes = encodeMidi(buildMidiData());
      const url = URL.createObjectURL(new Blob([bytes], { type: 'audio/midi' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'sxratch-song.mid';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      _toast('Exported MIDI (chords · bass · lead · drums).');
    } catch (e) {
      console.warn('midi export failed', e);
      _toast('Could not export MIDI.');
    }
  }

  /* ---------------- named project slots ---------------- */
  // The working song still autosaves to sxratch.song on every edit; projects
  // are explicit named snapshots so starting a new idea can't destroy the last.
  const PROJECTS_KEY = 'sxratch.projects';
  const PROJECTS_SCHEMA_V = 1;
  const PROJECTS_MAX = 20; // all snapshots share one localStorage key — cap it
  function readProjects() {
    return readVersioned(PROJECTS_KEY, PROJECTS_SCHEMA_V, [(p) => p]) || {};
  }
  function writeProjects(p) {
    return writeVersioned(PROJECTS_KEY, PROJECTS_SCHEMA_V, p, {
      onQuota: () => _toast('Could not save — browser storage is full.'),
    });
  }
  const projectSizeKb = (p) => Math.max(1, Math.round(JSON.stringify(p.song || {}).length / 1024));
  const fmtSavedAt = (ts) => {
    const d = new Date(ts);
    return d.toLocaleDateString() + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  function ensureProjectsDialog() {
    let dlg = document.getElementById('projects-dialog');
    if (dlg) return dlg;
    dlg = el('div', 'dialog');
    dlg.id = 'projects-dialog';
    dlg.hidden = true;
    dlg.innerHTML = `
      <div class="dialog-card">
        <h3>Projects</h3>
        <p class="muted">Named snapshots saved in this browser. The current song also autosaves separately, and loading is undoable (Ctrl+Z).</p>
        <div class="projects-new">
          <input id="project-name" type="text" placeholder="Name this song…" maxlength="48" />
          <button class="btn primary" id="project-save" type="button">Save current</button>
        </div>
        <div id="projects-list" class="projects-list"></div>
        <div class="dialog-actions"><button class="btn" id="projects-close" type="button">Close</button></div>
      </div>`;
    document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.hidden = true; });
    dlg.querySelector('#projects-close').addEventListener('click', () => { dlg.hidden = true; });
    dlg.querySelector('#project-save').addEventListener('click', () => {
      const input = dlg.querySelector('#project-name');
      const name = (input.value || '').trim() ||
        `Song · ${song.sections.length} sections · ${new Date().toLocaleDateString()}`;
      const projects = readProjects();
      if (Object.keys(projects).length >= PROJECTS_MAX) {
        _toast(`Project limit (${PROJECTS_MAX}) reached — delete one from the list first.`);
        return;
      }
      projects[String(Date.now())] = { name, savedAt: Date.now(), song: JSON.parse(JSON.stringify(song)) };
      if (writeProjects(projects)) {
        input.value = '';
        refreshProjectsList(dlg);
        _toast(`Saved “${name}”.`);
      }
    });
    return dlg;
  }

  function refreshProjectsList(dlg) {
    const list = dlg.querySelector('#projects-list');
    const projects = readProjects();
    const ids = Object.keys(projects).sort((a, b) => (projects[b].savedAt || 0) - (projects[a].savedAt || 0));
    list.innerHTML = '';
    if (!ids.length) {
      list.appendChild(el('div', 'project-empty', 'No saved projects yet — name the current song above and hit Save.'));
      return;
    }
    ids.forEach(id => {
      const rec = projects[id];
      const item = el('div', 'project-item');
      const info = el('div', 'p-info');
      info.append(
        el('div', 'p-name', rec.name || 'Untitled'),
        el('div', 'p-meta', `${(rec.song?.sections || []).length} sections · ${rec.song?.bpm || '—'} BPM · ~${projectSizeKb(rec)} KB · ${fmtSavedAt(rec.savedAt || +id)}`)
      );
      const load = el('button', 'btn', 'Load');
      load.type = 'button';
      load.addEventListener('click', () => {
        if (!rec.song || !Array.isArray(rec.song.sections)) { _toast('That save looks corrupted.'); return; }
        pushState(); // loading is one undo step away from your current song
        song = JSON.parse(JSON.stringify(rec.song));
        idc = Math.max(0, ...song.sections.map(s => s.id || 0));
        const bpmSlider = $('#song-bpm');
        if (bpmSlider) { bpmSlider.value = song.bpm || 90; const v = $('#song-bpm-v'); if (v) v.textContent = song.bpm || 90; }
        const hs = $('#song-humanize'); if (hs) hs.value = String(song.humanize || 0);
        render();
        dlg.hidden = true;
        _toast(`Loaded “${rec.name}”.`);
      });
      const del = el('button', 'btn project-del', 'Delete');
      del.type = 'button';
      del.addEventListener('click', () => {
        if (!del.classList.contains('confirm')) {
          del.classList.add('confirm');
          del.textContent = 'Sure?';
          setTimeout(() => { del.classList.remove('confirm'); del.textContent = 'Delete'; }, 2600);
          return;
        }
        const p = readProjects();
        delete p[id];
        if (writeProjects(p)) refreshProjectsList(dlg);
      });
      item.append(info, load, del);
      list.appendChild(item);
    });
  }

  function openProjects() {
    const dlg = ensureProjectsDialog();
    refreshProjectsList(dlg);
    dlg.hidden = false;
    dlg.querySelector('#project-name')?.focus();
  }

  /* ---------------- external MIDI note entry ---------------- */
  // Called by the app's Web MIDI layer while the PAD view is open: plays and
  // writes through the shared keyboard exactly as if the key were tapped.
  function midiNote(note, vel = 1) {
    const s = song.sections[song.selected];
    if (!s || !document.getElementById('pad-keyboard-dock')) return;
    handleSharedKeyPress(s, Math.max(KBD_LO, Math.min(KBD_HI, note | 0)), Math.max(0.1, Math.min(1.25, vel || 1)));
  }

  /* ---------------- init ---------------- */
  function init(deps = {}) {
    if (deps.getCtx) _getCtx = deps.getCtx;
    if (deps.toast) _toast = deps.toast;
    if (deps.onUse) _onUse = deps.onUse;
    if (deps.getSampler) _getSampler = deps.getSampler;
    const root = $('#song-builder');
    if (!root || root.dataset.built) { render(); return; }
    root.dataset.built = '1';
    root.innerHTML = `
      <div class="form-row song-meta">
        <label>Tempo <span id="song-bpm-v">90</span> BPM<input type="range" id="song-bpm" min="50" max="180" step="1" value="90"></label>
        <label class="song-engine">Sound
          <select id="song-engine" title="Synth = instant oscillators · Sampled = real General MIDI instruments">
            <option value="synth">Synth (instant)</option>
            <option value="sample">Sampled · GM</option>
          </select>
        </label>
        <label class="song-engine">Feel
          <select id="song-humanize" title="Timing humanize — subtle ±ms note offsets (deterministic: the same song always renders the same)">
            <option value="0">Tight (quantized)</option>
            <option value="5">Loose (±5 ms)</option>
            <option value="12">Human (±12 ms)</option>
          </select>
        </label>
        <span id="song-engine-status" class="hint"></span>
        <button id="btn-song-preview" class="btn" disabled>▶ Preview song</button>
        <button id="btn-song-preview-stop" class="btn">⏹</button>
        <button id="btn-song-deckA" class="btn btn-primary" disabled>→ Deck A</button>
        <button id="btn-song-deckB" class="btn btn-primary" disabled>→ Deck B</button>
        <button id="btn-song-dl" class="btn" disabled>⬇ WAV</button>
        <button id="btn-song-export" class="btn" title="Export song as JSON">Export JSON</button>
        <button id="btn-song-import" class="btn" title="Import song from JSON">Import JSON</button>
        <button id="btn-song-undo" class="btn" disabled title="Undo (Ctrl+Z)">Undo</button>
        <button id="btn-song-redo" class="btn" disabled title="Redo (Ctrl+Y)">Redo</button>
        <button id="btn-song-projects" class="btn" title="Save / load named songs (stored in this browser)">Projects</button>
        <button id="btn-song-midi" class="btn" disabled title="Export chords · bass · lead · drums as a standard .mid file">MIDI</button>
        <input type="file" id="song-import-file" accept=".json" hidden />
        <span id="song-duration" class="hint"></span>
      </div>
      <div class="song-add"><span class="label-sm">Add section</span><div id="song-add-btns"></div></div>
      <div class="song-timeline">
        <span class="label-sm">Arrangement timeline</span>
        <div id="song-structure" class="song-structure"></div>
      </div>
      <div id="song-editor" class="song-editor hidden"></div>`;

    upgradePadShell(root);

    $('#song-bpm').addEventListener('input', () => { song.bpm = +$('#song-bpm').value; $('#song-bpm-v').textContent = song.bpm; $('#song-duration').textContent = song.sections.length ? `${totalSeconds().toFixed(1)}s · ${song.sections.length} sections` : ''; renderCache.clear(); saveSong(); });
    // Timing feel (humanize) — stored on the song, rendered into the audio.
    const humSel = $('#song-humanize');
    humSel.addEventListener('change', () => {
      pushState();
      song.humanize = +humSel.value || 0;
      renderCache.clear();
      saveSong();
    });

    // Tap tempo: click the BPM number repeatedly to tap the song tempo in.
    {
      const bpmVal = $('#song-bpm-v');
      const tapper = createTapTempo({ min: 50, max: 180 });
      bpmVal.style.cursor = 'pointer';
      bpmVal.title = 'Click repeatedly to tap the tempo';
      bpmVal.addEventListener('click', () => {
        const bpm = tapper.tap(performance.now());
        if (bpm == null) return;
        pushState();
        song.bpm = Math.round(bpm);
        $('#song-bpm').value = song.bpm;
        bpmVal.textContent = song.bpm;
        renderCache.clear();
        saveSong();
        _toast(`Tapped ${song.bpm} BPM`);
      });
    }
    $('#song-bpm').addEventListener('pointerdown', () => { pushState(); });
    // Keyboard edits (arrow keys on the slider) get an undo point too.
    let bpmKeyEdit = false;
    $('#song-bpm').addEventListener('keydown', () => { if (!bpmKeyEdit) { bpmKeyEdit = true; pushState(); } });
    $('#song-bpm').addEventListener('blur', () => { bpmKeyEdit = false; });
    $('#song-bpm').addEventListener('change', () => { bpmKeyEdit = false; });
    const addBtns = $('#song-add-btns');
    SECTION_TYPES.forEach(t => { const b = el('button', 'btn btn-mini', '+ ' + t); b.addEventListener('click', () => addSection(t)); addBtns.appendChild(b); });
    $('#btn-song-preview').addEventListener('click', preview);
    $('#btn-song-preview-stop').addEventListener('click', () => { stopPreview(); stopSectionPlay(); });
    $('#btn-song-deckA').addEventListener('click', () => sendToDeck('A'));
    $('#btn-song-deckB').addEventListener('click', () => sendToDeck('B'));
    $('#btn-song-dl').addEventListener('click', downloadSong);

    $('#btn-song-export').addEventListener('click', () => {
      const blob = new Blob([JSON.stringify(song, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `sxratch-song-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      _toast('Song configuration exported.');
    });

    const importBtn = $('#btn-song-import');
    const importInput = $('#song-import-file');
    importBtn.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (evt) => {
        try {
          const parsed = JSON.parse(evt.target.result);
          if (parsed && Array.isArray(parsed.sections)) {
            song = parsed;
            idc = Math.max(0, ...song.sections.map(s => s.id || 0));
            $('#song-bpm').value = song.bpm || 90;
            $('#song-bpm-v').textContent = song.bpm || 90;
            render();
            _toast('Song configuration imported!');
          } else {
            _toast('Invalid song file structure.');
          }
        } catch (err) {
          _toast('Failed to parse song JSON file.');
        }
      };
      reader.readAsText(file);
      importInput.value = '';
    });

    $('#btn-song-undo').addEventListener('click', undo);
    $('#btn-song-redo').addEventListener('click', redo);
    $('#btn-song-projects').addEventListener('click', openProjects);
    $('#btn-song-midi').addEventListener('click', downloadMidi);

    // Sound engine: synth (default) ⟷ sampled General MIDI. Switching to sampled
    // lazy-creates the bank and preloads the instruments the current song uses.
    const engineSel = $('#song-engine');
    const engineStatus = $('#song-engine-status');
    engineSel.addEventListener('change', async () => {
      useSamples = engineSel.value === 'sample';
      renderCache.clear(); // engine change invalidates rendered audio
      if (!useSamples) { engineStatus.textContent = ''; return; }
      if (!sampleBank) sampleBank = new SampleBank(_getCtx());
      engineSel.disabled = true;
      engineStatus.textContent = '⏳ Loading instruments…';
      try {
        const cov = await ensureSamples(song.sections);
        if (cov.needed > 0 && cov.loaded === 0) throw new Error('no samples decoded');
        engineStatus.textContent = cov.loaded < cov.needed
          ? `✓ Ready — ${cov.needed - cov.loaded}/${cov.needed} notes unavailable (synth fills in)`
          : '✓ Sampled instruments ready';
      } catch (e) {
        console.warn('sample load failed', e);
        useSamples = false; engineSel.value = 'synth';
        engineStatus.textContent = 'Could not load samples — using synth';
        _toast('Could not load sampled instruments (offline?). Using synth.');
      }
      engineSel.disabled = false;
    });

    // Persist any pending debounced save before the page goes away.
    window.addEventListener('pagehide', flushSong);
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') flushSong(); });

    window.addEventListener('keydown', e => {
      if (!document.body.classList.contains('view-studio')) return;
      // Any form control, not just type=text: number and range inputs were
      // swallowing Ctrl+Z into their own native undo, and a focused <select>
      // would eat the shortcut entirely.
      const ae = document.activeElement;
      if (ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA' || ae.tagName === 'SELECT' || ae.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey) {
        if (e.key.toLowerCase() === 'z') {
          e.preventDefault();
          undo();
        } else if (e.key.toLowerCase() === 'y') {
          e.preventDefault();
          redo();
        }
      }
    });

    // Restore saved song from localStorage if it exists (versioned + migrated)
    const parsed = readVersioned("sxratch.song", SONG_SCHEMA_V, SONG_MIGRATIONS);
    let loaded = false;
    if (parsed && Array.isArray(parsed.sections)) {
      song = parsed;
      idc = Math.max(0, ...song.sections.map(s => s.id || 0));
      $('#song-bpm').value = song.bpm || 90;
      $('#song-bpm-v').textContent = song.bpm || 90;
      $('#song-humanize').value = String(song.humanize || 0);
      loaded = true;
    }

    if (!loaded) {
      song.sections = [makeSection('Intro'), makeSection('Verse'), makeSection('Chorus')];
      song.selected = 0;
    }
    render();
    restorePortedSamples(); // async: ⚠ sampler rows resolve when IDB slices land
  }

  return { init, stopPreview: () => { stopPreview(); stopSectionPlay(); }, midiNote };
})();
// (sendToDeck passes song.bpm so the deck readout / SYNC / auto-loop are correct.)
