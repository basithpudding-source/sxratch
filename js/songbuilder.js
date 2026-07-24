import { SampleBank, GM_PROGRAMS } from './instruments.js';
import { floatToInt16 } from './theory.js';
import { encodeMidi } from './midiexport.js';
import {
  playInstrument, playDrumHit, makeReverbSend, makeEchoSend, makeChorus,
  glueCompressor, masterFinalize, stepRand,
  resolvePatch, factoryValue, ENGINE_SCHEMA, FACTORY_PATCHES, WAVES, FILTER_TYPES,
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
  const LABEL_W = 52, GAP = 3, CELL_W = 20;
  const colX = c => LABEL_W + GAP + c * (CELL_W + GAP);

  const TL_SCALE = 14;       // px per second for the proportional timeline
  let idc = 0;
  let song = { bpm: 90, sections: [], selected: 0 };
  let loopSection = false;   // loop the per-section preview
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
  const secPerQuarter = () => 60 / song.bpm;
  const unitSec = s => (4 / s.ts.den) * secPerQuarter();
  const barSec = s => s.ts.num * unitSec(s);
  const stepSec = s => barSec(s) / stepsPerBar(s);
  const sectionSec = s => barSec(s) * s.bars;
  const totalSeconds = () => song.sections.reduce((t, s) => t + sectionSec(s), 0);
  const fmtTime = sec => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;

  function seedDrums(s) {
    const spb = stepsPerBar(s), sub = s.subdiv, num = s.ts.num, tot = totalSteps(s);
    const d = {}; DRUM_ROWS.forEach(r => d[r.key] = new Array(tot).fill(0));
    const hatEvery = Math.max(1, Math.round(sub / 2));
    for (let bar = 0; bar < s.bars; bar++) {
      for (let beat = 0; beat < num; beat++) {
        const idx = bar * spb + beat * sub;
        if (beat === 0 || beat === Math.floor(num / 2)) d.kick[idx] = beat === 0 ? 2 : 1; // accent the one
        if (num >= 4 ? beat % 2 === 1 : beat === Math.floor(num / 2)) d.snare[idx] = 1;
      }
      for (let st = 0; st < spb; st += hatEvery) d.hat[bar * spb + st] = 1;
    }
    d.crash[0] = 1;
    return d;
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
  function lane(title, sub, key) {
    const laneKey = key || title.toLowerCase();
    const l = el('div', `song-lane song-lane-${laneKey}` + (activePadMode === laneKey ? ' active-lane' : ''));
    l.dataset.lane = laneKey;
    const h = el('div', 'song-lane-head');
    const badge = el('button', 'song-lane-focus', title.toUpperCase());
    badge.type = 'button';
    badge.addEventListener('click', () => setActivePadMode(laneKey));
    h.append(badge, el('span', 'song-lane-title', title), el('span', 'song-lane-sub', sub));
    l.appendChild(h);
    return l;
  }
  const cellMarks = (c, sub, spb) => (c % spb === 0 ? ' bar' : (c % sub === 0 ? ' beat' : ''));

  const PAD_MODES = [
    { key: 'chords', label: 'CHORDS', icon: '▰▰▰' },
    { key: 'bass', label: 'BASS', icon: '♩' },
    { key: 'lead', label: 'LEAD', icon: '⌁' },
    { key: 'drums', label: 'DRUMS', icon: '▦' },
    { key: 'sampler', label: 'SAMPLE', icon: '◫' },
  ];
  let activePadMode = 'chords';
  let noteCursor = { bass: { row: 0, col: 0 }, lead: { row: 0, col: 0 } };
  let drumCursor = { key: 'kick', col: 0 };

  function setActivePadMode(mode, rerender = true) {
    activePadMode = PAD_MODES.some(m => m.key === mode) ? mode : 'chords';
    if (!rerender) return;
    // Targeted update: toggle lane focus classes + repaint the keyboard dock.
    // A full renderEditor() (which rebuilds every grid and the 250-node
    // keybed) is only needed when the editor doesn't exist yet.
    const ed = $('#song-editor');
    const lanes = ed ? ed.querySelectorAll('.song-lane') : null;
    const s = song.sections[song.selected];
    if (!lanes || !lanes.length || !s) { renderEditor(); return; }
    lanes.forEach(l => l.classList.toggle('active-lane', l.dataset.lane === activePadMode));
    refreshSharedKeyboard(s);
  }

  /** Rebuild just one lane's step grid in place (scroll preserved). */
  function refreshLaneGrid(s, kind) {
    const lane = document.querySelector(`.song-lane[data-lane="${kind}"]`);
    const old = lane && lane.querySelector('.seq-grid');
    if (!old) { renderEditor(); return; }
    const fresh = kind === 'drums' ? buildDrumGrid(s) : buildNoteGrid(s, kind);
    const sl = old.scrollLeft;
    old.replaceWith(fresh);
    fresh.scrollLeft = sl;
  }

  let undoStack = [];
  let redoStack = [];

  function pushState() {
    if (undoStack.length >= 30) undoStack.shift();
    undoStack.push(JSON.stringify(song));
    redoStack = []; // clear redo on new action
    updateUndoRedoButtons();
  }

  function undo() {
    if (!undoStack.length) return;
    redoStack.push(JSON.stringify(song));
    const previous = undoStack.pop();
    song = JSON.parse(previous);
    idc = Math.max(0, ...song.sections.map(s => s.id || 0));
    const bpmSlider = $('#song-bpm');
    if (bpmSlider) {
      bpmSlider.value = song.bpm || 90;
      const bpmVal = $('#song-bpm-v');
      if (bpmVal) bpmVal.textContent = song.bpm || 90;
    }
    render();
  }

  function redo() {
    if (!redoStack.length) return;
    undoStack.push(JSON.stringify(song));
    const next = redoStack.pop();
    song = JSON.parse(next);
    idc = Math.max(0, ...song.sections.map(s => s.id || 0));
    const bpmSlider = $('#song-bpm');
    if (bpmSlider) {
      bpmSlider.value = song.bpm || 90;
      const bpmVal = $('#song-bpm-v');
      if (bpmVal) bpmVal.textContent = song.bpm || 90;
    }
    render();
  }

  function updateUndoRedoButtons() {
    const undoBtn = $('#btn-song-undo');
    const redoBtn = $('#btn-song-redo');
    if (undoBtn) undoBtn.disabled = undoStack.length === 0;
    if (redoBtn) redoBtn.disabled = redoStack.length === 0;
  }

  let _saveTimer = null;
  function writeSong() {
    try {
      localStorage.setItem("sxratch.song", JSON.stringify(song));
    } catch (e) {
      console.error("Auto-save failed", e);
    }
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

  function renderEditor() {
    const ed = $('#song-editor');
    ed.innerHTML = '';
    if (!song.sections.length) {
      ed.classList.add('hidden');
      renderInspector(null);
      return;
    }
    ed.classList.remove('hidden');
    song.selected = Math.max(0, Math.min(song.selected, song.sections.length - 1));
    const s = song.sections[song.selected];
    ensureMix(s);

    /* play toolbar */
    const top = el('div', 'song-ed-top');
    const playBtn = el('button', 'btn btn-primary', '▶ Play section'); playBtn.id = 'btn-song-play-sec';
    playBtn.addEventListener('click', toggleSectionPlay);
    const loopLbl = el('label', 'check'); const loopCb = el('input'); loopCb.type = 'checkbox'; loopCb.checked = loopSection;
    loopCb.addEventListener('change', () => {
      loopSection = loopCb.checked;
      if (sectionPlay) { sectionPlay.loop = loopSection; sectionPlay.src.loop = loopSection; if (loopSection) { sectionPlay.src.loopStart = 0; sectionPlay.src.loopEnd = sectionPlay.dur; } }
    });
    loopLbl.append(loopCb, document.createTextNode(' 🔁 Loop'));
    top.append(playBtn, loopLbl, el('span', 'hint', `Editing: ${s.name || s.type} · ${sectionSec(s).toFixed(1)}s`));
    ed.appendChild(top);

    /* header controls (per-section, incl. key + instruments) */
    const head = el('div', 'song-ed-head');
    const typeSel = el('select'); SECTION_TYPES.forEach(t => typeSel.appendChild(opt(t, t, t === s.type)));
    typeSel.addEventListener('change', () => { pushState(); s.type = typeSel.value; s.name = s.type; renderStructure(); saveSong(); });
    head.appendChild(labelWrap('Section', typeSel));

    const nameIn = el('input'); nameIn.type = 'text'; nameIn.value = s.name || s.type; nameIn.className = 'section-name-input';
    nameIn.style.width = '100px';
    nameIn.addEventListener('change', () => {
      pushState();
      s.name = nameIn.value.trim() || s.type;
      renderStructure();
      saveSong();
    });
    head.appendChild(labelWrap('Name', nameIn));

    const keySel = el('select'); NOTE_NAMES.forEach((n, i) => keySel.appendChild(opt(i, n, i === s.key)));
    keySel.addEventListener('change', () => { pushState(); s.key = +keySel.value; renderEditor(); renderStructure(); saveSong(); });
    head.appendChild(labelWrap('Key', keySel));

    const tsSel = el('select'); TIME_SIGS.forEach(t => tsSel.appendChild(opt(t.label, t.label, t.num === s.ts.num && t.den === s.ts.den)));
    tsSel.addEventListener('change', () => { pushState(); const t = TIME_SIGS.find(x => x.label === tsSel.value); s.ts = { num: t.num, den: t.den }; reflow(s); render(); });
    head.appendChild(labelWrap('Time signature', tsSel));

    const barsIn = el('input'); barsIn.type = 'number'; barsIn.min = 1; barsIn.max = 64; barsIn.value = s.bars; barsIn.className = 'bars-input';
    barsIn.addEventListener('change', () => { pushState(); s.bars = Math.max(1, Math.min(64, parseInt(barsIn.value, 10) || 1)); reflow(s); render(); });
    head.appendChild(labelWrap('Bars', barsIn));

    const subSel = el('select'); SUBDIVS.forEach(d => subSel.appendChild(opt(d.v, d.label, d.v === s.subdiv)));
    subSel.addEventListener('change', () => { pushState(); s.subdiv = +subSel.value; reflow(s); render(); });
    head.appendChild(labelWrap('Step grid', subSel));

    // Swing: delays every 2nd step (MPC-style). 0% = straight, ~33% ≈ triplet feel.
    const swingLbl = el('label');
    const swingVal = el('span', 'swing-readout', Math.round((s.swing || 0) * 100) + '%');
    const swingIn = el('input');
    swingIn.type = 'range'; swingIn.min = 0; swingIn.max = 0.45; swingIn.step = 0.01;
    swingIn.value = s.swing || 0;
    swingIn.title = 'Swing — delays every 2nd step (≈33% is a triplet feel)';
    let swingEdit = false;
    const beginSwing = () => { if (!swingEdit) { pushState(); swingEdit = true; } };
    swingIn.addEventListener('pointerdown', beginSwing);
    swingIn.addEventListener('keydown', beginSwing);
    swingIn.addEventListener('change', () => { swingEdit = false; });
    swingIn.addEventListener('input', () => {
      s.swing = +swingIn.value;
      swingVal.textContent = Math.round(s.swing * 100) + '%';
      renderCache.clear();
      saveSong();
    });
    swingLbl.append(document.createTextNode('Swing '), swingVal, swingIn);
    head.appendChild(swingLbl);

    // Changing a lane's sound swaps in a different patch (and often a different
    // engine), so the inspector's synth editor has to be rebuilt with it.
    const csSel = el('select'); CHORD_SOUNDS.forEach(o => csSel.appendChild(opt(o.id, o.label, o.id === s.chordSound)));
    csSel.addEventListener('change', () => { pushState(); s.chordSound = csSel.value; renderCache.clear(); renderInspector(s); saveSong(); });
    head.appendChild(labelWrap('Chord sound', csSel));

    const bsSel = el('select'); BASS_SOUNDS.forEach(o => bsSel.appendChild(opt(o.id, o.label, o.id === s.bassSound)));
    bsSel.addEventListener('change', () => { pushState(); s.bassSound = bsSel.value; renderCache.clear(); renderInspector(s); saveSong(); });
    head.appendChild(labelWrap('Bass sound', bsSel));

    const ldSel = el('select'); LEAD_SOUNDS.forEach(o => ldSel.appendChild(opt(o.id, o.label, o.id === s.leadSound)));
    ldSel.addEventListener('change', () => { pushState(); s.leadSound = ldSel.value; renderCache.clear(); renderInspector(s); saveSong(); });
    head.appendChild(labelWrap('Lead sound', ldSel));

    const dkSel = el('select'); DRUM_KITS.forEach(o => dkSel.appendChild(opt(o.id, o.label, o.id === s.drumKit)));
    dkSel.addEventListener('change', () => { pushState(); s.drumKit = dkSel.value; saveSong(); });
    head.appendChild(labelWrap('Drum kit', dkSel));

    const del = el('button', 'btn btn-mini btn-danger', 'Delete section');
    del.addEventListener('click', () => removeSection(song.selected));
    head.appendChild(del);

    /* chords — build a chord on the keyboard, then drag it onto the single-row timeline */
    const chordsLane = lane('Chords', 'shared keyboard builds chords · drag onto the timeline to place · tap a placed chord to edit/remove', 'chords');
    if (chordSelSid !== s.id) { chordSelSid = s.id; chordSelStep = null; builtNotes = []; }
    const chordBody = el('div'); chordBody.id = 'chord-lane-body';
    chordBody.append(buildChordRow(s));
    chordsLane.appendChild(chordBody);

    /* bass */
    const bassLane = lane('Bass', 'click/drag the grid, or use the shared keyboard to record the cursor note', 'bass');
    const bTools = el('div', 'lane-tools');
    const fill = el('button', 'btn btn-mini', 'Root-follow');
    fill.addEventListener('click', () => {
      pushState();
      autofillBass(s);
      renderEditor();
      saveSong();
    });
    const bclr = el('button', 'btn btn-mini', 'Clear');
    bclr.addEventListener('click', () => {
      pushState();
      s.bass = new Array(totalSteps(s)).fill(null);
      renderEditor();
      saveSong();
    });
    bTools.append(fill, bclr);
    bassLane.append(bTools, buildBassGrid(s));

    /* lead */
    const leadLane = lane('Lead', 'melody grid · shared keyboard writes to the selected step', 'lead');
    const lTools = el('div', 'lane-tools');
    const lclr = el('button', 'btn btn-mini', 'Clear');
    lclr.addEventListener('click', () => {
      pushState();
      s.lead = new Array(totalSteps(s)).fill(null);
      renderEditor();
      saveSong();
    });
    lTools.appendChild(lclr);
    leadLane.append(lTools, buildLeadGrid(s));

    /* drums */
    const drumLane = lane('Drums', 'taps cycle hit → accent → ghost → off · keyboard maps to drum hits when focused', 'drums');
    const dTools = el('div', 'lane-tools');
    const dclr = el('button', 'btn btn-mini', 'Clear');
    dclr.addEventListener('click', () => {
      pushState();
      DRUM_ROWS.forEach(r => s.drums[r.key] = new Array(totalSteps(s)).fill(false));
      renderEditor();
      saveSong();
    });
    dTools.appendChild(dclr);
    drumLane.append(dTools, buildDrumGrid(s));

    /* sampler — port pad samples and play them on a custom multi-row grid */
    const samplerLane = buildSamplerLane(s);

    const laneStack = el('div', 'pad-lane-stack');
    laneStack.append(chordsLane, bassLane, leadLane, drumLane, samplerLane);

    ed.append(head, laneStack, buildSharedKeyboardDock(s));
    renderInspector(s);
  }

  // Which chord slot the editor targets (tracked per section).
  let chordSelSid = null;     // section whose chord state we currently hold
  let chordSelStep = null;    // start step of the selected placed chord
  let builtNotes = [];        // the chord currently built on the keyboard (midi notes)

  function previewNotes(s, notes) {
    if (notes && notes.length) voiceChord(_getCtx(), pvOut(), notes, _getCtx().currentTime + 0.02, 0.9, s.chordSound, 1, _pvNoise, patchFor(s, 'chords'));
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
    dock.querySelectorAll('.pad-mode-tab').forEach(t =>
      t.classList.toggle('active', t.dataset.mode === activePadMode));
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
    renderInspector(s);
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
    const tabs = el('div', 'pad-mode-tabs');
    PAD_MODES.forEach(m => {
      const b = el('button', 'pad-mode-tab' + (activePadMode === m.key ? ' active' : ''));
      b.type = 'button';
      b.dataset.mode = m.key;
      b.append(el('span', 'pad-mode-icon', m.icon), el('span', null, m.label));
      b.addEventListener('click', () => setActivePadMode(m.key));
      tabs.appendChild(b);
    });

    const status = el('div', 'pad-keyboard-status');
    const mode = PAD_MODES.find(m => m.key === activePadMode) || PAD_MODES[0];
    status.append(el('span', 'label-sm', 'Shared keyboard'));
    status.append(el('strong', null, mode.label));
    status.append(el('span', 'hint', modeSoundName(s, activePadMode)));

    top.append(tabs, status, buildSharedKeyboardControls(s));
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

  function handleSharedKeyPress(s, midi) {
    if (activePadMode === 'chords') {
      const idx = builtNotes.indexOf(midi);
      if (idx >= 0) builtNotes.splice(idx, 1); else builtNotes.push(midi);
      builtNotes.sort((a, b) => a - b);
      previewNotes(s, [midi]);
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
      kind === 'bass' ? previewBass(s, row) : previewLead(s, row);
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
      if (nv) previewDrum(s, row.key, DRUM_VELS[nv] || 1);
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
        const nd = noise.getChannelData(0);
        for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
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
    g.strokeStyle = 'rgba(141,176,207,0.28)';
    g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, mid); g.lineTo(w, mid); g.stroke();
    const grad = g.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, '#7fe3ff'); grad.addColorStop(1, '#ffbd3d');
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

  function renderInspector(s) {
    const panel = $('#song-inspector');
    if (!panel) return;
    // The inspector is rebuilt by many interactions (lane switches, keybed
    // refreshes); keep the user's place in the now-scrollable panel.
    const keepScroll = panel.scrollTop;
    panel.innerHTML = '';
    if (!s) {
      panel.append(el('div', 'song-inspector-empty', 'Add a section to start building a song.'));
      return;
    }
    const mode = PAD_MODES.find(m => m.key === activePadMode) || PAD_MODES[0];
    const head = el('div', 'inspector-head');
    head.append(el('span', 'label-sm', 'Selected instrument'), el('strong', null, mode.label), el('span', 'hint', modeSoundName(s, activePadMode)));

    // A real rendered note of the lane's current patch — not decoration.
    const wave = el('div', 'inspector-wave');
    if (PATCH_FAMILY[activePadMode]) {
      const cv = el('canvas', 'patch-preview');
      cv.id = 'patch-preview';
      wave.appendChild(cv);
    } else {
      wave.appendChild(el('span', 'hint', activePadMode === 'drums' ? 'Drum kit — pick a kit above' : 'Sampler lane'));
    }

    const actions = el('div', 'inspector-actions');
    const actionBtn = (label, fn, cls = '') => {
      const b = el('button', 'btn btn-mini inspector-action ' + cls, label);
      b.type = 'button';
      b.addEventListener('click', fn);
      actions.appendChild(b);
      return b;
    };
    actionBtn(sectionPlay ? 'Stop section' : 'Preview section', () => sectionPlay ? stopSectionPlay() : toggleSectionPlay(), 'btn-primary');
    actionBtn('Duplicate section', () => duplicateSection(song.selected));
    if (activePadMode === 'chords') {
      actionBtn('Clear built chord', () => { builtNotes = []; refreshChords(s); });
      actionBtn('Clear chord lane', () => { pushState(); s.chords = new Array(totalSteps(s)).fill(null); chordSelStep = null; builtNotes = []; renderEditor(); saveSong(); }, 'btn-danger');
    } else if (activePadMode === 'bass') {
      actionBtn('Root-follow', () => { pushState(); autofillBass(s); renderEditor(); saveSong(); });
      actionBtn('Clear bass', () => { pushState(); s.bass = new Array(totalSteps(s)).fill(null); renderEditor(); saveSong(); }, 'btn-danger');
    } else if (activePadMode === 'lead') {
      actionBtn('Clear lead', () => { pushState(); s.lead = new Array(totalSteps(s)).fill(null); renderEditor(); saveSong(); }, 'btn-danger');
    } else if (activePadMode === 'drums') {
      actionBtn('Clear current step', () => {
        pushState();
        DRUM_ROWS.forEach(r => s.drums[r.key][drumCursor.col] = false);
        renderEditor();
        saveSong();
      });
      actionBtn('Clear drum kit', () => { pushState(); DRUM_ROWS.forEach(r => s.drums[r.key] = new Array(totalSteps(s)).fill(false)); renderEditor(); saveSong(); }, 'btn-danger');
    } else if (activePadMode === 'sampler') {
      actionBtn('Import pads', portFromPads);
      actionBtn('Add sample row', () => addSamplerRow(s));
    }

    const stats = el('div', 'inspector-stats');
    [
      ['Key', NOTE_NAMES[s.key]],
      ['Bars', String(s.bars)],
      ['Steps', String(totalSteps(s))],
      ['Grid', `${s.ts.num}/${s.ts.den}`],
    ].forEach(([a, b]) => {
      const item = el('div', 'inspector-stat');
      item.append(el('span', null, a), el('strong', null, b));
      stats.appendChild(item);
    });

    const mixer = el('div', 'inspector-mixer');
    const cols = totalSteps(s);
    const densities = {
      Chords: s.chords.filter(Boolean).length / Math.max(1, cols),
      Bass: s.bass.filter(Boolean).length / Math.max(1, cols),
      Lead: s.lead.filter(Boolean).length / Math.max(1, cols),
      Drums: DRUM_ROWS.reduce((n, r) => n + (s.drums[r.key] || []).filter(Boolean).length, 0) / Math.max(1, cols * DRUM_ROWS.length),
      Sample: (s.samplerRows || []).reduce((n, row) => n + (row.placements || []).filter(Boolean).length, 0) / Math.max(1, cols),
    };
    densities.Master = Math.min(1, Object.values(densities).reduce((a, b) => a + b, 0) / 2);
    ['Chords', 'Bass', 'Lead', 'Drums', 'Sample', 'Master'].forEach((name) => {
      const strip = el('div', 'mini-strip');
      strip.append(el('span', null, name.slice(0, 2).toUpperCase()));
      const meter = el('div', 'mini-meter');
      const fill = el('i');
      fill.style.height = Math.max(8, Math.round((densities[name] || 0) * 92)) + '%';
      meter.appendChild(fill);
      strip.appendChild(meter);
      mixer.appendChild(strip);
    });

    const synth = buildSynthPanel(s);
    panel.append(head, wave, actions, stats, buildTrackMixPanel(s));
    if (synth) panel.appendChild(synth);
    panel.appendChild(mixer);
    if (keepScroll) panel.scrollTop = keepScroll;
    if (PATCH_FAMILY[activePadMode]) drawPatchPreview(panel.querySelector('#patch-preview'), s, activePadMode);
  }

  // Scrollable piano — tap keys to build a chord; its recognised name shows live.
  function buildChordKeyboard(s) {
    const panel = el('div', 'chord-kbd-panel');
    const top = el('div', 'chord-kbd-top');
    const readout = el('div', 'chord-readout' + (builtNotes.length ? '' : ' rest'), builtNotes.length ? nameChord(builtNotes) : 'Tap keys to build a chord →');
    const hear = el('button', 'btn btn-mini', '▶ Hear'); hear.addEventListener('click', () => previewNotes(s, builtNotes));
    const clr = el('button', 'btn btn-mini', 'Clear'); clr.addEventListener('click', () => { builtNotes = []; refreshChords(s); });
    top.append(readout, hear, clr);
    if (chordSelStep != null && s.chords[chordSelStep]) {
      const rm = el('button', 'btn btn-mini btn-danger', '✕ Remove placed');
      rm.addEventListener('click', () => { s.chords[chordSelStep] = null; chordSelStep = null; refreshChords(s); });
      top.appendChild(rm);
    }
    panel.appendChild(top);

    const kbd = el('div', 'chord-kbd');
    const inner = el('div', 'kbd-inner');
    const whiteMidis = [];
    for (let m = KBD_LO; m <= KBD_HI; m++) if (!BLACK_PCS.includes(m % 12)) whiteMidis.push(m);
    inner.style.width = (whiteMidis.length * KW) + 'px';
    whiteMidis.forEach((m, i) => {
      const wk = el('button', 'kbd-key white' + (builtNotes.includes(m) ? ' sel' : ''));
      wk.dataset.midi = m; wk.style.left = (i * KW) + 'px';
      if (m === KBD_LO || m % 12 === 0 || m === KBD_HI) wk.appendChild(el('span', 'kbd-label', keyName(m)));
      inner.appendChild(wk);
      if ([0, 2, 5, 7, 9].includes(m % 12) && m + 1 <= KBD_HI) {
        const bm = m + 1;
        const bk = el('button', 'kbd-key black' + (builtNotes.includes(bm) ? ' sel' : ''));
        bk.dataset.midi = bm; bk.style.left = ((i + 1) * KW - KBW / 2) + 'px';
        inner.appendChild(bk);
      }
    });
    inner.addEventListener('click', e => {
      const k = e.target.closest('.kbd-key'); if (!k) return;
      const m = +k.dataset.midi, idx = builtNotes.indexOf(m);
      if (idx >= 0) builtNotes.splice(idx, 1); else builtNotes.push(m);
      builtNotes.sort((a, b) => a - b);
      previewNotes(s, [m]);
      refreshChords(s);
    });
    kbd.appendChild(inner);
    panel.appendChild(kbd);
    setTimeout(() => { if (!kbd.dataset.scrolled && kbd.scrollWidth > kbd.clientWidth) kbd.scrollLeft = Math.max(0, ((60 - KBD_LO) / (KBD_HI - KBD_LO)) * kbd.scrollWidth - kbd.clientWidth / 2); }, 0);
    return panel;
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
    return grid;
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
      refreshChords(s);
      saveSong();
    });
    grid.addEventListener('pointercancel', () => { clearPaint(); drag = null; });
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
      const fresh = buildNoteGrid(s, kind); const sl = grid.scrollLeft; grid.replaceWith(fresh); fresh.scrollLeft = sl;
      refreshSharedKeyboard(s);
      saveSong();
    });
    grid.addEventListener('pointercancel', () => { clearPaint(); drag = null; });
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
      n++;
    });
    if (!n) { _toast('No samples in the pads — load some on the SXRATCH sampler first.'); return; }
    if (!findPorted(smpSel.sampleId)) smpSel.sampleId = portedSamples[0].id;
    _toast(`Imported ${n} sample(s) from the pads.`);
    renderEditor();
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
    makeGeneratedSample('Starter Kick', 0.48, (t, p) => Math.sin(2 * Math.PI * (94 - p * 52) * t) * Math.exp(-7.2 * p));
    makeGeneratedSample('Starter Snare', 0.38, (t, p) => ((Math.random() * 2 - 1) * Math.exp(-10 * p) * 0.7) + Math.sin(2 * Math.PI * 186 * t) * Math.exp(-12 * p) * 0.25);
    makeGeneratedSample('Starter Hat', 0.18, (t, p) => (Math.random() * 2 - 1) * Math.exp(-18 * p) * (p > 0.04 ? 0.55 : 0.2));
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

  // Scrollable keyboard to choose the transpose (C4 = original pitch).
  function buildSamplerKeyboard(s) {
    const panel = el('div', 'chord-kbd-panel');
    const kbd = el('div', 'chord-kbd');
    const inner = el('div', 'kbd-inner');
    const selMidi = 60 + smpSel.transpose;
    const whiteMidis = [];
    for (let m = KBD_LO; m <= KBD_HI; m++) if (!BLACK_PCS.includes(m % 12)) whiteMidis.push(m);
    inner.style.width = (whiteMidis.length * KW) + 'px';
    whiteMidis.forEach((m, i) => {
      const wk = el('button', 'kbd-key white' + (m === selMidi ? ' sel' : ''));
      wk.dataset.midi = m; wk.style.left = (i * KW) + 'px';
      if (m === KBD_LO || m % 12 === 0 || m === KBD_HI) wk.appendChild(el('span', 'kbd-label', keyName(m)));
      inner.appendChild(wk);
      if ([0, 2, 5, 7, 9].includes(m % 12) && m + 1 <= KBD_HI) {
        const bm = m + 1;
        const bk = el('button', 'kbd-key black' + (bm === selMidi ? ' sel' : ''));
        bk.dataset.midi = bm; bk.style.left = ((i + 1) * KW - KBW / 2) + 'px';
        inner.appendChild(bk);
      }
    });
    inner.addEventListener('click', e => {
      const k = e.target.closest('.kbd-key'); if (!k) return;
      smpSel.transpose = (+k.dataset.midi) - 60;
      if (findPorted(smpSel.sampleId)) previewSampleConfig(s);
      refreshSamplerConfig(s);
    });
    kbd.appendChild(inner);
    panel.appendChild(kbd);
    setTimeout(() => { if (!kbd.dataset.scrolled && kbd.scrollWidth > kbd.clientWidth) kbd.scrollLeft = Math.max(0, ((60 - KBD_LO) / (KBD_HI - KBD_LO)) * kbd.scrollWidth - kbd.clientWidth / 2); }, 0);
    return panel;
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
      activePadMode = 'sampler';
      refreshSharedKeyboard(s);
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
      if (!row) return;
      if (len === 1 && row.placements[a]) { row.placements[a] = null; }       // click a placement to remove it
      else { notesClearRange(row.placements, a, a + len); row.placements[a] = { len }; previewRow(s, row, len); }
      const fresh = buildSamplerGrid(s); const sl = grid.scrollLeft; grid.replaceWith(fresh); fresh.scrollLeft = sl;
      saveSong();
    });
    grid.addEventListener('pointercancel', () => { clearPaint(); drag = null; });
  }
  function buildSamplerLane(s) {
    s.samplerRows = s.samplerRows || [];
    const laneEl = lane('Sampler', 'port pad samples · use shared keyboard to transpose · drag cells to play until release', 'sampler');
    laneEl.append(buildSamplerConfig(s), buildSamplerGrid(s));
    return laneEl;
  }

  /* ---------------- structure ops ---------------- */
  function addSection(type) { pushState(); song.sections.push(makeSection(type, song.sections[song.selected])); song.selected = song.sections.length - 1; render(); }
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
      const d = _pvNoise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    return _pvMaster;
  }
  function previewBass(s, row) { const ac = _getCtx(); voiceBass(ac, pvOut(), 36 + s.key + MAJOR[row], ac.currentTime + 0.02, 0.5, s.bassSound, 1, _pvNoise, patchFor(s, 'bass')); }
  function previewLead(s, row) { const ac = _getCtx(); voiceLead(ac, pvOut(), 72 + s.key + MAJOR[row], ac.currentTime + 0.02, 0.5, s.leadSound, 1, _pvNoise, patchFor(s, 'lead')); }
  function previewDrum(s, key, vel = 1) {
    const ac = _getCtx();
    voiceDrum(ac, pvOut(), key, ac.currentTime + 0.02, _pvNoise, s.drumKit || 'acoustic', vel);
  }

  /* ---- sampled-instrument routing ----
   * With the sampled engine on and the mapped GM instrument decoded, play a real
   * multisample; otherwise fall back to the synth.js patch. The synth path is
   * always the default and the offline / no-network fallback. `vel` carries the
   * humanized per-step velocity into both paths. */
  function voiceChord(oc, dest, notes, at, dur, sound, vel = 1, noise = null, patch = null) {
    if (useSamples && sampleBank) {
      const prog = GM_PROGRAMS.chord[sound];
      if (prog && notes.every(m => sampleBank.has(prog, m))) { notes.forEach(m => sampleBank.play(prog, m, dest, at, dur, 0.8 * vel)); return; }
    }
    notes.forEach((m, i) => playInstrument('chord', sound, oc, dest, m, at, dur, vel, { noise, ndx: i, count: notes.length, patch }));
  }
  function voiceBass(oc, dest, m, at, dur, sound, vel = 1, noise = null, patch = null) {
    if (useSamples && sampleBank) { const prog = GM_PROGRAMS.bass[sound]; if (prog && sampleBank.has(prog, m)) { sampleBank.play(prog, m, dest, at, dur, 0.85 * vel); return; } }
    playInstrument('bass', sound, oc, dest, m, at, dur, vel, { noise, patch });
  }
  function voiceLead(oc, dest, m, at, dur, sound, vel = 1, noise = null, patch = null) {
    if (useSamples && sampleBank) { const prog = GM_PROGRAMS.lead[sound]; if (prog && sampleBank.has(prog, m)) { sampleBank.play(prog, m, dest, at, dur, 0.8 * vel); return; } }
    playInstrument('lead', sound, oc, dest, m, at, dur, vel, { noise, patch });
  }
  // Drums: sampled kit one-shot when loaded, else the synth.js drum sample
  // (rendered once per kit/key, so each hit is a single BufferSource).
  function voiceDrum(oc, dest, key, at, noise, kit, vel = 1) {
    if (useSamples && sampleBank && sampleBank.hasDrum(kit, key)) {
      let out = dest;
      if (vel !== 1) { const g = oc.createGain(); g.gain.value = vel; g.connect(dest); out = g; }
      sampleBank.playDrum(kit, key, out, at, 0.7);
      return;
    }
    playDrumHit(oc, dest, kit, key, at, vel);
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
      // Tempo-synced ping-pong (dotted eighth) with darkening repeats.
      const echo = makeEchoSend(oc, {
        time: (60 / song.bpm) * 0.75,
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
    const tAt = (c) => t + c * ss + (c % 2 === 1 ? sw : 0);
    // Resolve each lane's patch once per section, not per note.
    const pChords = patchFor(s, 'chords'), pBass = patchFor(s, 'bass'), pLead = patchFor(s, 'lead');
    s.chords.forEach((ch, c) => { if (ch) voiceChord(oc, bus.chords.input, ch.notes, tAt(c), ss * ch.len, s.chordSound, stepVel(s, 1, c), noise, pChords); });
    s.bass.forEach((n, c) => { if (n) voiceBass(oc, bus.bass.input, 36 + s.key + MAJOR[n.r], tAt(c), ss * n.len, s.bassSound, stepVel(s, 2, c), noise, pBass); });
    (s.lead || []).forEach((n, c) => { if (n) voiceLead(oc, bus.lead.input, 72 + s.key + MAJOR[n.r], tAt(c), ss * n.len, s.leadSound, stepVel(s, 3, c), noise, pLead); });
    const kit = s.drumKit || 'acoustic';
    DRUM_ROWS.forEach((r, ri) => s.drums[r.key].forEach((on, c) => {
      const v = drumVal(on);
      if (!v) return;
      const jit = 1 + (stepRand((s.id * 524287) ^ (ri + 11), c) - 0.5) * 0.07;
      voiceDrum(oc, bus.drums.input, r.key, tAt(c), noise, kit, (DRUM_VELS[v] || 1) * jit);
    }));
    (s.samplerRows || []).forEach(row => {
      const samp = findPorted(row.sampleId); if (!samp) return;
      row.placements.forEach((n, c) => { if (n) playSampleBuffer(oc, bus.sampler.input, samp.buffer, row.transpose, n.len * ss, tAt(c)); });
    });
  }

  async function renderSections(sections) {
    if (!sections.length) return null;
    // Memoize the offline render: Preview / → Deck / WAV re-rendered the whole
    // song every click even when nothing changed. Key on engine + tempo + content.
    const key = (useSamples ? 's|' : 'y|') + song.bpm + '|' + JSON.stringify(sections);
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
    const noise = oc.createBuffer(1, sr, sr); const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    let t = 0;
    sections.forEach(s => { renderSectionInto(oc, master, noise, s, t); t += sectionSec(s); });
    const buffer = await oc.startRendering();
    const chans = [];
    for (let c = 0; c < buffer.numberOfChannels; c++) chans.push(buffer.getChannelData(c));
    masterFinalize(chans, sr); // consistent loudness + true-peak ceiling, in place
    renderCache.set(key, buffer);
    while (renderCache.size > 4) renderCache.delete(renderCache.keys().next().value); // cap memory
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
      const startAt = ac.currentTime + 0.06;
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
    function follow(grid, x) { const sl = grid.scrollLeft, w = grid.clientWidth; if (x < sl + 40) grid.scrollLeft = Math.max(0, x - 40); else if (x > sl + w - 40) grid.scrollLeft = x - w + 40; }
    (function loop() {
      const sp = sectionPlay; if (!sp) return;
      let elapsed = ac.currentTime - sp.startAt;
      if (elapsed >= 0) {
        if (sp.loop) elapsed = elapsed % sp.dur;
        else if (elapsed >= sp.dur) { stopSectionPlay(); return; }
        const x = colX(elapsed / stepSec(sp.s));
        grids.forEach(({ g, h }) => { if (h) { h.style.left = x + 'px'; h.style.display = 'block'; } follow(g, x); });
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
        _onUse(buf, songLabel(), deck, song.bpm, cues);
        _toast(`Loaded onto Deck ${deck} — sections are on hot cues 1–${Math.min(8, cues.length)}.`);
      }
    } catch (e) { console.warn(e); _toast('Could not render the song.'); }
    btn.textContent = txt; btn.disabled = false;
  }

  // Encode an AudioBuffer to a 16-bit PCM WAV blob.
  function bufferToWav(buf) {
    const ch = buf.numberOfChannels, len = buf.length, sr = buf.sampleRate;
    const data = new DataView(new ArrayBuffer(44 + len * ch * 2));
    const wr = (o, s) => { for (let i = 0; i < s.length; i++) data.setUint8(o + i, s.charCodeAt(i)); };
    wr(0, 'RIFF'); data.setUint32(4, 36 + len * ch * 2, true); wr(8, 'WAVE'); wr(12, 'fmt ');
    data.setUint32(16, 16, true); data.setUint16(20, 1, true); data.setUint16(22, ch, true);
    data.setUint32(24, sr, true); data.setUint32(28, sr * ch * 2, true); data.setUint16(32, ch * 2, true);
    data.setUint16(34, 16, true); wr(36, 'data'); data.setUint32(40, len * ch * 2, true);
    let o = 44;
    const chans = []; for (let c = 0; c < ch; c++) chans.push(buf.getChannelData(c));
    for (let i = 0; i < len; i++) for (let c = 0; c < ch; c++) {
      data.setInt16(o, floatToInt16(chans[c][i]), true); o += 2;
    }
    return new Blob([data], { type: 'audio/wav' });
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

    // Panel title only — the topbar's SXRATCH / PAD nav already carries the
    // brand; repeating the wordmark here read as two competing logos.
    const brand = el('div', 'pad-brand-block');
    const main = el('span', 'pad-brand-main');
    main.innerHTML = 'SONG <b>BUILDER</b>';
    brand.append(main);

    meta.classList.remove('form-row');
    meta.classList.add('pad-transport-cluster');
    const engine = meta.querySelector('.song-engine');
    if (engine) engine.classList.add('pad-engine-module');
    const bpm = meta.querySelector('label:first-child');
    if (bpm) bpm.classList.add('pad-bpm-module');
    const status = meta.querySelector('#song-engine-status');
    if (status) status.classList.add('pad-engine-status');

    const transport = el('header', 'pad-transport');
    transport.append(brand, meta);

    const railHead = el('div', 'rail-head');
    railHead.append(el('span', 'label-sm', 'Song sections'));
    if (duration) railHead.appendChild(duration);
    const performance = el('div', 'rail-performance rail-workflow');
    const steps = el('ol', 'rail-workflow-list');
    ['Pick a section', 'Focus a track lane', 'Draw, play, preview, then send to deck'].forEach(txt => steps.appendChild(el('li', null, txt)));
    performance.append(el('span', 'label-sm', 'Workflow'), steps);

    const rail = el('aside', 'pad-section-rail');
    rail.append(railHead, add, timeline, performance);
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
    const timeSigs = [];
    let tick = 0, lastSig = '';
    song.sections.forEach(s => {
      const tps = TPQ * (4 / s.ts.den) / s.subdiv; // ticks per step
      const sw = (s.swing || 0) * tps;
      const tAt = c => Math.round(tick + c * tps + (c % 2 === 1 ? sw : 0));
      const sig = s.ts.num + '/' + s.ts.den;
      if (sig !== lastSig) { timeSigs.push({ tick: Math.round(tick), num: s.ts.num, den: s.ts.den }); lastSig = sig; }
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
  function readProjects() {
    try { return JSON.parse(localStorage.getItem(PROJECTS_KEY) || '{}') || {}; }
    catch { return {}; }
  }
  function writeProjects(p) {
    try { localStorage.setItem(PROJECTS_KEY, JSON.stringify(p)); return true; }
    catch { _toast('Could not save — browser storage is full.'); return false; }
  }
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
        el('div', 'p-meta', `${(rec.song?.sections || []).length} sections · ${rec.song?.bpm || '—'} BPM · ${fmtSavedAt(rec.savedAt || +id)}`)
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
  function midiNote(note) {
    const s = song.sections[song.selected];
    if (!s || !document.getElementById('pad-keyboard-dock')) return;
    handleSharedKeyPress(s, Math.max(KBD_LO, Math.min(KBD_HI, note | 0)));
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

    $('#song-bpm').addEventListener('input', () => { song.bpm = +$('#song-bpm').value; $('#song-bpm-v').textContent = song.bpm; $('#song-duration').textContent = song.sections.length ? `${totalSeconds().toFixed(1)}s · ${song.sections.length} sections` : ''; saveSong(); });
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
      if (document.activeElement && document.activeElement.tagName === 'INPUT' && document.activeElement.type === 'text') return;
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

    // Restore saved song from localStorage if it exists
    const saved = localStorage.getItem("sxratch.song");
    let loaded = false;
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        if (parsed && Array.isArray(parsed.sections)) {
          song = parsed;
          idc = Math.max(0, ...song.sections.map(s => s.id || 0));
          $('#song-bpm').value = song.bpm || 90;
          $('#song-bpm-v').textContent = song.bpm || 90;
          loaded = true;
        }
      } catch (e) {
        console.error("Failed to load saved song", e);
      }
    }

    if (!loaded) {
      song.sections = [makeSection('Intro'), makeSection('Verse'), makeSection('Chorus')];
      song.selected = 0;
    }
    render();
  }

  return { init, stopPreview: () => { stopPreview(); stopSectionPlay(); }, midiNote };
})();
// (sendToDeck passes song.bpm so the deck readout / SYNC / auto-loop are correct.)
