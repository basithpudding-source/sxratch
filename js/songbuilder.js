import { SampleBank, GM_PROGRAMS } from './instruments.js';
import { floatToInt16 } from './theory.js';

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
  const KBD_LO = 48, KBD_HI = 84;     // C3 … C6
  const KW = 34, KBW = 22;            // white / black key widths
  const BLACK_PCS = [1, 3, 6, 8, 10];

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
    const d = {}; DRUM_ROWS.forEach(r => d[r.key] = new Array(tot).fill(false));
    const hatEvery = Math.max(1, Math.round(sub / 2));
    for (let bar = 0; bar < s.bars; bar++) {
      for (let beat = 0; beat < num; beat++) {
        const idx = bar * spb + beat * sub;
        if (beat === 0 || beat === Math.floor(num / 2)) d.kick[idx] = true;
        if (num >= 4 ? beat % 2 === 1 : beat === Math.floor(num / 2)) d.snare[idx] = true;
      }
      for (let st = 0; st < spb; st += hatEvery) d.hat[bar * spb + st] = true;
    }
    d.crash[0] = true;
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
      bars: d.bars, chords: [], drums: {}, bass: [], lead: [], samplerRows: [],
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
    const ts = totalSteps(s);
    const oc = s.chords || [];
    s.chords = Array.from({ length: ts }, (_, i) => { const ch = oc[i]; return ch ? { ...ch, len: Math.min(ch.len, ts - i) } : null; });
    const nd = {}; DRUM_ROWS.forEach(r => { const old = s.drums[r.key] || []; nd[r.key] = Array.from({ length: ts }, (_, i) => !!old[i]); });
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
  function lane(title, sub) { const l = el('div', 'song-lane'); const h = el('div', 'song-lane-head'); h.append(el('span', 'song-lane-title', title), el('span', 'song-lane-sub', sub)); l.appendChild(h); return l; }
  const cellMarks = (c, sub, spb) => (c % spb === 0 ? ' bar' : (c % sub === 0 ? ' beat' : ''));

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
    ['#btn-song-preview', '#btn-song-deckA', '#btn-song-deckB', '#btn-song-dl', '#btn-song-export'].forEach(sel => { const b = $(sel); if (b) b.disabled = !has; });
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
    if (!song.sections.length) { ed.classList.add('hidden'); return; }
    ed.classList.remove('hidden');
    song.selected = Math.max(0, Math.min(song.selected, song.sections.length - 1));
    const s = song.sections[song.selected];

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
    top.append(playBtn, loopLbl, el('span', 'hint', `Editing: ${s.type} · ${sectionSec(s).toFixed(1)}s`));
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

    const csSel = el('select'); CHORD_SOUNDS.forEach(o => csSel.appendChild(opt(o.id, o.label, o.id === s.chordSound)));
    csSel.addEventListener('change', () => { pushState(); s.chordSound = csSel.value; saveSong(); });
    head.appendChild(labelWrap('Chord sound', csSel));

    const bsSel = el('select'); BASS_SOUNDS.forEach(o => bsSel.appendChild(opt(o.id, o.label, o.id === s.bassSound)));
    bsSel.addEventListener('change', () => { pushState(); s.bassSound = bsSel.value; saveSong(); });
    head.appendChild(labelWrap('Bass sound', bsSel));

    const ldSel = el('select'); LEAD_SOUNDS.forEach(o => ldSel.appendChild(opt(o.id, o.label, o.id === s.leadSound)));
    ldSel.addEventListener('change', () => { pushState(); s.leadSound = ldSel.value; saveSong(); });
    head.appendChild(labelWrap('Lead sound', ldSel));

    const dkSel = el('select'); DRUM_KITS.forEach(o => dkSel.appendChild(opt(o.id, o.label, o.id === s.drumKit)));
    dkSel.addEventListener('change', () => { pushState(); s.drumKit = dkSel.value; saveSong(); });
    head.appendChild(labelWrap('Drum kit', dkSel));

    const del = el('button', 'btn btn-mini btn-danger', 'Delete section');
    del.addEventListener('click', () => removeSection(song.selected));
    head.appendChild(del);

    /* chords — build a chord on the keyboard, then drag it onto the single-row timeline */
    const chordsLane = lane('Chords', 'build a chord on the keys · drag onto the timeline to place it · tap a placed chord to edit, again to remove');
    if (chordSelSid !== s.id) { chordSelSid = s.id; chordSelStep = null; builtNotes = []; }
    const chordBody = el('div'); chordBody.id = 'chord-lane-body';
    chordBody.append(buildChordKeyboard(s), buildChordRow(s));
    chordsLane.appendChild(chordBody);

    /* bass */
    const bassLane = lane('Bass', 'click a note — or drag across cells to hold it');
    const bTools = el('div', 'lane-tools');
    const fill = el('button', 'btn btn-mini', 'Root-follow'); fill.addEventListener('click', () => { autofillBass(s); renderEditor(); });
    const bclr = el('button', 'btn btn-mini', 'Clear'); bclr.addEventListener('click', () => { s.bass = new Array(totalSteps(s)).fill(null); renderEditor(); });
    bTools.append(fill, bclr);
    bassLane.append(bTools, buildBassGrid(s));

    /* lead */
    const leadLane = lane('Lead', 'melody — click a note, or drag across cells to hold it');
    const lTools = el('div', 'lane-tools');
    const lclr = el('button', 'btn btn-mini', 'Clear'); lclr.addEventListener('click', () => { s.lead = new Array(totalSteps(s)).fill(null); renderEditor(); });
    lTools.appendChild(lclr);
    leadLane.append(lTools, buildLeadGrid(s));

    /* drums */
    const drumLane = lane('Drums', 'full kit, across the section');
    const dTools = el('div', 'lane-tools');
    const dclr = el('button', 'btn btn-mini', 'Clear'); dclr.addEventListener('click', () => { DRUM_ROWS.forEach(r => s.drums[r.key] = new Array(totalSteps(s)).fill(false)); renderEditor(); });
    dTools.appendChild(dclr);
    drumLane.append(dTools, buildDrumGrid(s));

    /* sampler — port pad samples and play them on a custom multi-row grid */
    const samplerLane = buildSamplerLane(s);

    ed.append(head, chordsLane, bassLane, leadLane, drumLane, samplerLane);
  }

  // Which chord slot the editor targets (tracked per section).
  let chordSelSid = null;     // section whose chord state we currently hold
  let chordSelStep = null;    // start step of the selected placed chord
  let builtNotes = [];        // the chord currently built on the keyboard (midi notes)

  function previewNotes(s, notes) {
    if (notes && notes.length) voiceChord(_getCtx(), pvOut(), notes, _getCtx().currentTime + 0.02, 0.9, s.chordSound);
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
      if (m % 12 === 0) wk.appendChild(el('span', 'kbd-label', 'C' + (Math.floor(m / 12) - 1)));
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
    const oldKbd = body.querySelector('.chord-kbd'), oldRow = body.querySelector('.chord-grid');
    const ks = oldKbd ? oldKbd.scrollLeft : null, rs = oldRow ? oldRow.scrollLeft : 0;
    body.innerHTML = '';
    body.append(buildChordKeyboard(s), buildChordRow(s));
    const nk = body.querySelector('.chord-kbd'); if (nk && ks != null) { nk.scrollLeft = ks; nk.dataset.scrolled = '1'; }
    const nr = body.querySelector('.chord-grid'); if (nr) nr.scrollLeft = rs;
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
      const fresh = buildNoteGrid(s, kind); const sl = grid.scrollLeft; grid.replaceWith(fresh); fresh.scrollLeft = sl;
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
        const cell = el('button', 'seq-cell' + cellMarks(c, s.subdiv, spb) + (s.drums[r.key][c] ? ' on' : ''));
        cell.addEventListener('click', () => { s.drums[r.key][c] = !s.drums[r.key][c]; cell.classList.toggle('on', s.drums[r.key][c]); if (s.drums[r.key][c]) previewDrum(s, r.key); saveSong(); });
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
      if (m % 12 === 0) wk.appendChild(el('span', 'kbd-label', 'C' + (Math.floor(m / 12) - 1)));
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

    tools.appendChild(el('span', 'hint', 'Key: ' + noteLabel(60 + smpSel.transpose) + (smpSel.transpose ? ` (${smpSel.transpose > 0 ? '+' : ''}${smpSel.transpose} st)` : ' · original')));

    const hear = el('button', 'btn btn-mini', '▶ Hear'); hear.disabled = !portedSamples.length;
    hear.addEventListener('click', () => previewSampleConfig(s));
    tools.appendChild(hear);

    const add = el('button', 'btn btn-mini btn-primary', '+ Add row'); add.disabled = !portedSamples.length;
    add.addEventListener('click', () => addSamplerRow(s));
    tools.appendChild(add);

    wrap.append(tools, buildSamplerKeyboard(s));
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
    if (!s.samplerRows.length) return el('div', 'samp-empty hint', 'No sample rows yet — import samples, pick a key & length, then “Add row”.');
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
    const laneEl = lane('Sampler', 'port pad samples · tap a key to transpose (preview) · set length · Add row · drag cells to play — it stops where the drag ends');
    laneEl.append(buildSamplerConfig(s), buildSamplerGrid(s));
    return laneEl;
  }

  /* ---------------- structure ops ---------------- */
  function addSection(type) { pushState(); song.sections.push(makeSection(type, song.sections[song.selected])); song.selected = song.sections.length - 1; render(); }
  function duplicateSection(i) { pushState(); const copy = JSON.parse(JSON.stringify(song.sections[i])); copy.id = ++idc; song.sections.splice(i + 1, 0, copy); song.selected = i + 1; render(); }
  function removeSection(i) { pushState(); song.sections.splice(i, 1); if (song.selected >= song.sections.length) song.selected = song.sections.length - 1; render(); }
  function moveSection(i, dir) { const j = i + dir; if (j < 0 || j >= song.sections.length) return; pushState(); [song.sections[i], song.sections[j]] = [song.sections[j], song.sections[i]]; song.selected = j; render(); }

  /* ---------------- synthesis ---------------- */
  const freq = m => 440 * Math.pow(2, (m - 69) / 12);
  let DRIVE = null;
  function makeDrive() { const n = 1024, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = i / n * 2 - 1; c[i] = Math.tanh(x * 2.2); } return c; }
  function env(g, at, dur, peak, atk, rel) {
    g.gain.setValueAtTime(0.0001, at);
    g.gain.linearRampToValueAtTime(peak, at + atk);
    g.gain.setValueAtTime(peak, Math.max(at + atk + 0.001, at + dur - rel));
    g.gain.linearRampToValueAtTime(0.0001, at + dur);
  }
  function ksBuffer(oc, f, dur, decay) {
    const sr = oc.sampleRate, N = Math.max(2, Math.round(sr / f)), total = Math.ceil(dur * sr);
    const buf = oc.createBuffer(1, total, sr), out = buf.getChannelData(0);
    const ring = new Float32Array(N); for (let i = 0; i < N; i++) ring[i] = Math.random() * 2 - 1;
    let idx = 0;
    for (let i = 0; i < total; i++) { const cur = ring[idx], nxt = ring[(idx + 1) % N]; out[i] = cur; ring[idx] = 0.5 * (cur + nxt) * decay; idx = (idx + 1) % N; }
    return buf;
  }
  function playKS(oc, dest, f, at, dur, decay, gain, filt) {
    const src = oc.createBufferSource(); src.buffer = ksBuffer(oc, f, dur, decay);
    const g = oc.createGain(); g.gain.value = gain; let node = src;
    if (filt) { const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = filt; src.connect(lp); node = lp; }
    node.connect(g).connect(dest); src.start(at); src.stop(at + dur + 0.02);
  }
  function mkOsc(oc, dest, type, f, at, len, peak, atk, decTo) {
    const o = oc.createOscillator(); o.type = type; o.frequency.value = f;
    const g = oc.createGain();
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + atk); g.gain.exponentialRampToValueAtTime(0.0001, at + decTo);
    o.connect(g).connect(dest); o.start(at); o.stop(at + len + 0.05);
  }
  function chordVoice(oc, dest, notes, at, dur, sound) {
    if (sound === 'guitar') { notes.forEach((m, i) => playKS(oc, dest, freq(m), at + i * 0.02, Math.min(dur + 0.6, 2.4), 0.996, 0.5, 3500)); return; }
    notes.forEach(m => {
      if (sound === 'epiano') { const len = Math.min(dur, 2.2); mkOsc(oc, dest, 'sine', freq(m), at, len, 0.16, 0.004, len * 0.9); mkOsc(oc, dest, 'sine', freq(m) * 4, at, len * 0.5, 0.05, 0.003, len * 0.4); }
      else if (sound === 'organ') { [[1, 0.11], [2, 0.07], [3, 0.05], [4, 0.035]].forEach(([h, lv]) => { const o = oc.createOscillator(); o.type = 'sine'; o.frequency.value = freq(m) * h; const g = oc.createGain(); env(g, at, dur, lv, 0.012, 0.05); o.connect(g).connect(dest); o.start(at); o.stop(at + dur + 0.05); }); }
      else if (sound === 'strings') { [-0.06, 0.06].forEach(det => { const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq(m) * Math.pow(2, det / 12); const lfo = oc.createOscillator(); lfo.frequency.value = 5; const lg = oc.createGain(); lg.gain.value = freq(m) * 0.004; lfo.connect(lg).connect(o.frequency); lfo.start(at); lfo.stop(at + dur + 0.1); const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 2600; f.Q.value = 0.5; const g = oc.createGain(); env(g, at, dur, 0.06, 0.13, 0.28); o.connect(f).connect(g).connect(dest); o.start(at); o.stop(at + dur + 0.1); }); }
      else { [-0.07, 0.07].forEach(det => { const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq(m) * Math.pow(2, det / 12); const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.7; f.frequency.setValueAtTime(500, at); f.frequency.linearRampToValueAtTime(2000, at + Math.min(0.6, dur * 0.5)); const g = oc.createGain(); env(g, at, dur, 0.055, 0.06, 0.3); o.connect(f).connect(g).connect(dest); o.start(at); o.stop(at + dur + 0.1); }); }
    });
  }
  function bassVoice(oc, dest, m, at, dur, sound) {
    if (sound === 'upright') { playKS(oc, dest, freq(m), at, Math.min(dur, 3.5), 0.991, 0.55, 700); return; }
    if (sound === 'sub') { const ln = Math.min(dur, 4); mkOsc(oc, dest, 'sine', freq(m), at, ln, 0.3, 0.02, ln * 0.95); return; }
    if (sound === 'synth') { const o = oc.createOscillator(); o.type = 'sawtooth'; o.frequency.value = freq(m); const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 6; f.frequency.setValueAtTime(1900, at); f.frequency.exponentialRampToValueAtTime(240, at + 0.18); const g = oc.createGain(); const len = Math.min(dur, 3); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.28, at + 0.01); g.gain.setValueAtTime(0.22, Math.min(at + 0.2, at + len * 0.6)); g.gain.exponentialRampToValueAtTime(0.0001, at + len * 0.97); o.connect(f).connect(g).connect(dest); o.start(at); o.stop(at + len + 0.05); return; }
    const o = oc.createOscillator(); o.type = 'triangle'; o.frequency.value = freq(m);
    const ws = oc.createWaveShaper(); ws.curve = DRIVE;
    const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 900; f.Q.value = 1;
    const g = oc.createGain(); const len = Math.min(dur, 4);
    g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.3, at + 0.02); g.gain.setValueAtTime(0.24, Math.min(at + 0.25, at + len * 0.6)); g.gain.exponentialRampToValueAtTime(0.0001, at + len * 0.97);
    o.connect(ws).connect(f).connect(g).connect(dest); o.start(at); o.stop(at + len + 0.05);
  }
  function leadVoice(oc, dest, m, at, dur, sound) {
    const len = Math.min(dur * 0.95, 4);
    if (sound === 'guitar') { playKS(oc, dest, freq(m), at, Math.min(dur + 0.4, 4), 0.992, 0.4, 4000); return; }
    if (sound === 'bell') {
      const bl = Math.min(dur, 4);
      mkOsc(oc, dest, 'sine', freq(m), at, bl, 0.14, 0.004, bl * 0.9);
      mkOsc(oc, dest, 'sine', freq(m) * 2.76, at, Math.min(dur, 2), 0.05, 0.003, Math.min(dur, 2) * 0.4);
      return;
    }
    const o = oc.createOscillator();
    o.type = sound === 'square' ? 'square' : (sound === 'flute' ? 'sine' : 'sawtooth');
    o.frequency.value = freq(m);
    if (sound === 'flute' || sound === 'synth') { const lfo = oc.createOscillator(); lfo.frequency.value = 5.5; const lg = oc.createGain(); lg.gain.value = freq(m) * 0.006; lfo.connect(lg).connect(o.frequency); lfo.start(at); lfo.stop(at + len + 0.05); }
    const f = oc.createBiquadFilter(); f.type = 'lowpass'; f.Q.value = 0.6; f.frequency.value = sound === 'square' ? 3200 : (sound === 'flute' ? 2400 : 2800);
    const g = oc.createGain(); env(g, at, len, sound === 'flute' ? 0.12 : 0.11, sound === 'flute' ? 0.05 : 0.015, 0.06);
    o.connect(f).connect(g).connect(dest); o.start(at); o.stop(at + len + 0.05);
  }

  // Kit-aware drum voices (acoustic / 808 / electronic / bossa / lofi).
  function dKick(oc, d, at, n, kit) {
    let f0 = 120, f1 = 42, dec = 0.15, peak = 0.4;
    if (kit === '808') { f0 = 110; f1 = 38; dec = 0.6; peak = 0.5; }
    else if (kit === 'electronic') { f0 = 180; f1 = 48; dec = 0.13; peak = 0.42; }
    else if (kit === 'bossa') { f0 = 100; f1 = 45; dec = 0.12; peak = 0.3; }
    else if (kit === 'lofi') { f0 = 110; f1 = 40; dec = 0.16; peak = 0.34; }
    const o = oc.createOscillator(); o.frequency.setValueAtTime(f0, at); o.frequency.exponentialRampToValueAtTime(f1, at + Math.min(0.18, dec));
    const g = oc.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + 0.005); g.gain.exponentialRampToValueAtTime(0.0001, at + dec);
    let dest = d;
    if (kit === 'lofi') { const lp = oc.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1600; lp.connect(d); dest = lp; }
    o.connect(g).connect(dest); o.start(at); o.stop(at + dec + 0.05);
    if (kit === 'electronic') { const s = oc.createBufferSource(); s.buffer = n; const hp = oc.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 4000; const cg = oc.createGain(); cg.gain.setValueAtTime(0.12, at); cg.gain.exponentialRampToValueAtTime(0.0001, at + 0.02); s.connect(hp).connect(cg).connect(d); s.start(at, Math.random()); s.stop(at + 0.04); }
  }
  function dSnare(oc, d, at, n, kit) {
    if (kit === 'bossa') { // cross-stick / rim
      const s = oc.createBufferSource(); s.buffer = n; const f = oc.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 2500;
      const g = oc.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(0.1, at + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, at + 0.05);
      s.connect(f).connect(g).connect(d); s.start(at, Math.random()); s.stop(at + 0.06);
      const o = oc.createOscillator(); o.type = 'triangle'; o.frequency.value = 420; const g2 = oc.createGain(); g2.gain.setValueAtTime(0.1, at); g2.gain.exponentialRampToValueAtTime(0.0001, at + 0.05); o.connect(g2).connect(d); o.start(at); o.stop(at + 0.06);
      return;
    }
    let hp = 1500, ndec = 0.16, npeak = 0.24, tone = 190;
    if (kit === '808') { hp = 2000; ndec = 0.13; npeak = 0.22; tone = 180; }
    else if (kit === 'electronic') { hp = 1700; ndec = 0.18; npeak = 0.26; tone = 200; }
    else if (kit === 'lofi') { hp = 1200; ndec = 0.14; npeak = 0.18; tone = 180; }
    const s = oc.createBufferSource(); s.buffer = n; const f = oc.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
    const g = oc.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(npeak, at + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, at + ndec);
    s.connect(f).connect(g).connect(d); s.start(at, Math.random()); s.stop(at + ndec + 0.02);
    const o = oc.createOscillator(); o.type = 'triangle'; o.frequency.value = tone; const g2 = oc.createGain(); g2.gain.setValueAtTime(0.12, at); g2.gain.exponentialRampToValueAtTime(0.0001, at + 0.1); o.connect(g2).connect(d); o.start(at); o.stop(at + 0.12);
  }
  function dHat(oc, d, at, n, open, kit) {
    let hp = 7000, peak = open ? 0.07 : 0.06, len = open ? 0.32 : 0.045;
    if (kit === '808') { hp = 9000; peak = open ? 0.06 : 0.05; len = open ? 0.3 : 0.03; }
    else if (kit === 'electronic') { hp = 8000; }
    else if (kit === 'bossa') { hp = 5500; peak = open ? 0.05 : 0.035; len = open ? 0.34 : 0.07; }
    else if (kit === 'lofi') { hp = 6000; peak = open ? 0.05 : 0.04; }
    const s = oc.createBufferSource(); s.buffer = n; const f = oc.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = hp;
    const g = oc.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + 0.003); g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    s.connect(f).connect(g).connect(d); s.start(at, Math.random()); s.stop(at + len + 0.02);
  }
  function dCrash(oc, d, at, n, kit) {
    const len = kit === '808' ? 1.7 : kit === 'bossa' ? 1.0 : 1.3, peak = kit === 'bossa' ? 0.08 : 0.12;
    const s = oc.createBufferSource(); s.buffer = n; s.loop = true; const f = oc.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = kit === '808' ? 5000 : 4000;
    const g = oc.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, at + len);
    s.connect(f).connect(g).connect(d); s.start(at, Math.random()); s.stop(at + len + 0.05);
  }
  function dTom(oc, d, at, n, base, kit) {
    let dec = 0.3, peak = 0.26, type = 'sine';
    if (kit === '808') { dec = 0.5; peak = 0.28; }
    else if (kit === 'electronic') { dec = 0.22; type = 'triangle'; }
    else if (kit === 'bossa') { dec = 0.26; peak = 0.18; }
    else if (kit === 'lofi') { dec = 0.26; peak = 0.2; }
    const o = oc.createOscillator(); o.type = type; o.frequency.setValueAtTime(base * 1.4, at); o.frequency.exponentialRampToValueAtTime(base, at + 0.12);
    const g = oc.createGain(); g.gain.setValueAtTime(0.0001, at); g.gain.exponentialRampToValueAtTime(peak, at + 0.006); g.gain.exponentialRampToValueAtTime(0.0001, at + dec);
    o.connect(g).connect(d); o.start(at); o.stop(at + dec + 0.05);
  }

  /* ---------------- live previews (audition while building) ---------------- */
  let _pvMaster = null, _pvNoise = null;
  function pvOut() {
    const ac = _getCtx();
    if (!_pvMaster || _pvMaster.context !== ac) {
      _pvMaster = ac.createGain(); _pvMaster.gain.value = 0.9; _pvMaster.connect(ac.destination);
      _pvNoise = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
      const d = _pvNoise.getChannelData(0); for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (!DRIVE) DRIVE = makeDrive();
    return _pvMaster;
  }
  function previewBass(s, row) { const ac = _getCtx(); voiceBass(ac, pvOut(), 36 + s.key + MAJOR[row], ac.currentTime + 0.02, 0.5, s.bassSound); }
  function previewLead(s, row) { const ac = _getCtx(); voiceLead(ac, pvOut(), 72 + s.key + MAJOR[row], ac.currentTime + 0.02, 0.5, s.leadSound); }
  function previewDrum(s, key) {
    const ac = _getCtx();
    voiceDrum(ac, pvOut(), key, ac.currentTime + 0.02, _pvNoise, s.drumKit || 'acoustic');
  }

  /* ---- sampled-instrument routing ----
   * With the sampled engine on and the mapped GM instrument decoded, play a real
   * multisample; otherwise fall back to the oscillator voice. The synth path is
   * always the default and the offline / no-network fallback. */
  function voiceChord(oc, dest, notes, at, dur, sound) {
    if (useSamples && sampleBank) {
      const prog = GM_PROGRAMS.chord[sound];
      if (prog && notes.every(m => sampleBank.has(prog, m))) { notes.forEach(m => sampleBank.play(prog, m, dest, at, dur, 0.8)); return; }
    }
    chordVoice(oc, dest, notes, at, dur, sound);
  }
  function voiceBass(oc, dest, m, at, dur, sound) {
    if (useSamples && sampleBank) { const prog = GM_PROGRAMS.bass[sound]; if (prog && sampleBank.has(prog, m)) { sampleBank.play(prog, m, dest, at, dur, 0.85); return; } }
    bassVoice(oc, dest, m, at, dur, sound);
  }
  function voiceLead(oc, dest, m, at, dur, sound) {
    if (useSamples && sampleBank) { const prog = GM_PROGRAMS.lead[sound]; if (prog && sampleBank.has(prog, m)) { sampleBank.play(prog, m, dest, at, dur, 0.8); return; } }
    leadVoice(oc, dest, m, at, dur, sound);
  }
  // Drums: sampled kit one-shot when loaded, else the synth drum voice.
  function voiceDrum(oc, dest, key, at, noise, kit) {
    if (useSamples && sampleBank && sampleBank.hasDrum(kit, key)) { sampleBank.playDrum(kit, key, dest, at, 0.7); return; }
    const tom = { tomH: 260, tomM: 180, tomL: 120 };
    if (key === 'kick') dKick(oc, dest, at, noise, kit);
    else if (key === 'snare') dSnare(oc, dest, at, noise, kit);
    else if (key === 'hat') dHat(oc, dest, at, noise, false, kit);
    else if (key === 'open') dHat(oc, dest, at, noise, true, kit);
    else if (key === 'crash') dCrash(oc, dest, at, noise, kit);
    else dTom(oc, dest, at, noise, tom[key], kit);
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
    if (!useSamples || !sampleBank) return;
    const needs = sampleNeeds(sections);
    const drumKits = new Set();
    sections.forEach(s => { if (DRUM_ROWS.some(r => s.drums[r.key].some(Boolean))) drumKits.add(s.drumKit || 'acoustic'); });
    await Promise.all([
      ...[...needs].map(([prog, midis]) => sampleBank.ensure(prog, [...midis]).catch(() => {})),
      ...[...drumKits].map(kit => sampleBank.loadDrumKit(kit).catch(() => {})),
    ]);
  }

  function renderSectionInto(oc, master, noise, s, t) {
    const ss = stepSec(s);
    s.chords.forEach((ch, c) => { if (ch) voiceChord(oc, master, ch.notes, t + c * ss, ss * ch.len, s.chordSound); });
    s.bass.forEach((n, c) => { if (n) voiceBass(oc, master, 36 + s.key + MAJOR[n.r], t + c * ss, ss * n.len, s.bassSound); });
    (s.lead || []).forEach((n, c) => { if (n) voiceLead(oc, master, 72 + s.key + MAJOR[n.r], t + c * ss, ss * n.len, s.leadSound); });
    const kit = s.drumKit || 'acoustic';
    DRUM_ROWS.forEach(r => s.drums[r.key].forEach((on, c) => {
      if (!on) return; const at = t + c * ss;
      voiceDrum(oc, master, r.key, at, noise, kit);
    }));
    (s.samplerRows || []).forEach(row => {
      const samp = findPorted(row.sampleId); if (!samp) return;
      row.placements.forEach((n, c) => { if (n) playSampleBuffer(oc, master, samp.buffer, row.transpose, n.len * ss, t + c * ss); });
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
    const total = sections.reduce((a, s) => a + sectionSec(s), 0) + 1.6;
    const oc = new OfflineAudioContext(2, Math.ceil(total * sr), sr);
    DRIVE = makeDrive();
    const master = oc.createGain(); master.gain.value = 0.9;
    const comp = oc.createDynamicsCompressor(); master.connect(comp); comp.connect(oc.destination);
    const noise = oc.createBuffer(1, sr, sr); const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    let t = 0;
    sections.forEach(s => { renderSectionInto(oc, master, noise, s, t); t += sectionSec(s); });
    const buffer = await oc.startRendering();
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
      if (buf) { _onUse(buf, songLabel(), deck); _toast(`Loaded onto Deck ${deck} — switch to SXRATCH to play it.`); }
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
        <input type="file" id="song-import-file" accept=".json" hidden />
        <span id="song-duration" class="hint"></span>
      </div>
      <div class="song-add"><span class="label-sm">Add section</span><div id="song-add-btns"></div></div>
      <div class="song-timeline">
        <span class="label-sm">Arrangement timeline</span>
        <div id="song-structure" class="song-structure"></div>
      </div>
      <div id="song-editor" class="song-editor hidden"></div>`;

    $('#song-bpm').addEventListener('input', () => { song.bpm = +$('#song-bpm').value; $('#song-bpm-v').textContent = song.bpm; $('#song-duration').textContent = song.sections.length ? `${totalSeconds().toFixed(1)}s · ${song.sections.length} sections` : ''; saveSong(); });
    $('#song-bpm').addEventListener('pointerdown', () => { pushState(); });
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
        await ensureSamples(song.sections);
        engineStatus.textContent = '✓ Sampled instruments ready';
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

  return { init, stopPreview: () => { stopPreview(); stopSectionPlay(); } };
})();
