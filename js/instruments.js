// Sxratch sampled-instrument engine.
//
// The Song Builder synthesizes every instrument from oscillators (great: zero
// assets, instant, tunable — but unmistakably synthetic). This module adds an
// optional *sampled* backend: real multisampled General MIDI instruments, so a
// "warm pad" or "acoustic bass" actually sounds like one.
//
// Source: the MIDI.js / gleitz General MIDI soundfonts (FluidR3_GM), which host
// each instrument as one file of inline base64 note samples, fully chromatic
// (A0..C8). One fetch per instrument; we decode only the notes the song uses.
// No library dependency, no .sf2 parser. The synth path stays the default and
// the always-available fallback (offline, no network, instant).

import { noteNameToMidi, nearest } from "./theory.js";

const BASE = "https://gleitz.github.io/midi-js-soundfonts";

// General MIDI program names for each Song Builder instrument id.
export const GM_PROGRAMS = {
  chord: { pad: "pad_2_warm", strings: "string_ensemble_1", epiano: "electric_piano_1", organ: "drawbar_organ", guitar: "acoustic_guitar_nylon" },
  bass: { electric: "electric_bass_finger", synth: "synth_bass_1", upright: "acoustic_bass", sub: "synth_bass_2" },
  lead: { synth: "lead_2_sawtooth", square: "lead_1_square", flute: "flute", bell: "celesta", guitar: "acoustic_guitar_steel" },
};

// Real sampled drum kits (Tone.js one-shots, CORS-enabled GitHub Pages). Each
// Song Builder kit maps to a folder; each drum row maps to a one-shot filename
// (null = no sample, keep the synth voice, e.g. crash). Closed/open hats share
// the hihat sample (the closed one is gated short on playback).
const DRUMS_BASE = "https://tonejs.github.io/audio/drum-samples";
const DRUM_KIT_FOLDER = {
  acoustic: "acoustic-kit", "808": "Techno", electronic: "Kit8", bossa: "acoustic-kit", lofi: "CR78",
};
const DRUM_FILE = {
  kick: "kick", snare: "snare", hat: "hihat", open: "hihat", crash: null,
  tomH: "tom1", tomM: "tom2", tomL: "tom3",
};

function dataUriToArrayBuffer(uri) {
  const bin = atob(uri.slice(uri.indexOf(",") + 1));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

export class SampleBank {
  /** @param {AudioContext} ctx live context used to decode samples (buffers are reusable in offline contexts too). */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.base = opts.base || BASE;
    this.set = opts.set || "FluidR3_GM";
    this.programs = {};   // name -> { uris:{midi:dataURI}, buffers:Map<midi,AudioBuffer>, sorted:number[] }
    this._indexing = {};  // name -> Promise (in-flight index fetches)
    this.drumKits = {};   // folder -> { buffers:Map<file,AudioBuffer> } | { loading:Promise }
    this.drumsBase = opts.drumsBase || DRUMS_BASE;
  }

  /** Fetch + parse an instrument's note table (cheap; no audio decoded yet). */
  index(program) {
    const have = this.programs[program];
    if (have && have.uris) return Promise.resolve(have);
    if (this._indexing[program]) return this._indexing[program];
    const p = (async () => {
      const url = `${this.base}/${this.set}/${program}-mp3.js`;
      const text = await (await fetch(url)).text();
      const sf = new Function(text + ';return (typeof MIDI!=="undefined")?MIDI.Soundfont:null;')();
      const map = sf && (sf[program] || sf[Object.keys(sf)[0]]);
      if (!map) throw new Error("no soundfont data for " + program);
      const uris = {};
      for (const [note, uri] of Object.entries(map)) { const m = noteNameToMidi(note); if (m != null) uris[m] = uri; }
      const rec = { uris, buffers: new Map(), sorted: Object.keys(uris).map(Number).sort((a, b) => a - b) };
      this.programs[program] = rec;
      return rec;
    })();
    this._indexing[program] = p;
    p.finally(() => { delete this._indexing[program]; });
    return p;
  }

  /** Decode (once) the nearest available sample for `midi`. Resolves to the AudioBuffer or null. */
  async decodeNote(program, midi) {
    const rec = this.programs[program] && this.programs[program].uris ? this.programs[program] : await this.index(program);
    if (!rec.sorted.length) return null;
    const root = rec.uris[midi] != null ? midi : nearest(rec.sorted, midi);
    let buf = rec.buffers.get(root);
    if (!buf) {
      buf = await this.ctx.decodeAudioData(dataUriToArrayBuffer(rec.uris[root]));
      rec.buffers.set(root, buf);
    }
    return buf;
  }

  /** Pre-decode every note in `midis` for `program` (call before an offline render). */
  async ensure(program, midis) {
    await this.index(program);
    await Promise.all([...new Set(midis)].map((m) => this.decodeNote(program, m).catch(() => {})));
  }

  /** True if a playable (decoded) sample is already available for this note. */
  has(program, midi) {
    const rec = this.programs[program];
    if (!rec || !rec.sorted.length) return false;
    const root = rec.uris[midi] != null ? midi : nearest(rec.sorted, midi);
    return rec.buffers.has(root);
  }

  /**
   * Play a note. `dest`'s context is used (works for the live AudioContext and
   * for an OfflineAudioContext render alike). Returns true if a sample fired.
   */
  play(program, midi, dest, when, dur, velocity = 0.8) {
    const rec = this.programs[program];
    if (!rec || !rec.sorted.length) return false;
    const root = rec.uris[midi] != null ? midi : nearest(rec.sorted, midi);
    const buf = rec.buffers.get(root);
    if (!buf) return false;

    const ctx = dest.context;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    if (root !== midi) src.playbackRate.value = Math.pow(2, (midi - root) / 12);

    const g = ctx.createGain();
    // GM samples are mastered low (~0.07 peak at full velocity); a makeup gain
    // brings the sampled engine up to roughly the synth voices' loudness.
    const peak = Math.max(0.02, velocity) * 2.2;
    const rel = 0.16;
    const end = when + Math.max(0.05, dur);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(peak, when + 0.006);
    g.gain.setValueAtTime(peak, Math.max(when + 0.007, end - rel));
    g.gain.exponentialRampToValueAtTime(0.0001, end + rel);

    src.connect(g).connect(dest);
    src.start(when);
    src.stop(end + rel + 0.05);
    return true;
  }

  // ---- Sampled drum kits ----

  /** Fetch + decode the one-shots for a Song Builder drum kit (once). */
  loadDrumKit(kitId) {
    const folder = DRUM_KIT_FOLDER[kitId] || "acoustic-kit";
    const have = this.drumKits[folder];
    if (have && have.buffers) return Promise.resolve(have);
    if (have && have.loading) return have.loading;
    const promise = (async () => {
      const files = [...new Set(Object.values(DRUM_FILE).filter(Boolean))]; // kick,snare,hihat,tom1..3
      const buffers = new Map();
      await Promise.all(files.map(async (f) => {
        try {
          const ab = await (await fetch(`${this.drumsBase}/${folder}/${f}.mp3`)).arrayBuffer();
          buffers.set(f, await this.ctx.decodeAudioData(ab));
        } catch {}
      }));
      const rec = { buffers };
      this.drumKits[folder] = rec;
      return rec;
    })();
    this.drumKits[folder] = { loading: promise };
    return promise;
  }

  /** True if a decoded sample is available for this kit + drum row. */
  hasDrum(kitId, key) {
    const folder = DRUM_KIT_FOLDER[kitId] || "acoustic-kit";
    const rec = this.drumKits[folder];
    const file = DRUM_FILE[key];
    return !!(rec && rec.buffers && file && rec.buffers.has(file));
  }

  /** Fire a sampled drum hit. `open` lets a hi-hat ring; closed hats are gated. */
  playDrum(kitId, key, dest, when, velocity = 0.7) {
    const folder = DRUM_KIT_FOLDER[kitId] || "acoustic-kit";
    const rec = this.drumKits[folder];
    const file = DRUM_FILE[key];
    const buf = rec && rec.buffers && file ? rec.buffers.get(file) : null;
    if (!buf) return false;

    const ctx = dest.context;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    const peak = Math.max(0.02, velocity);
    g.gain.setValueAtTime(peak, when);
    if (key === "hat") { // closed hi-hat: choke it short
      g.gain.setValueAtTime(peak, when + 0.018);
      g.gain.exponentialRampToValueAtTime(0.0001, when + 0.06);
    }
    src.connect(g).connect(dest);
    src.start(when);
    src.stop(when + (key === "hat" ? 0.09 : Math.min(buf.duration, 3) + 0.02));
    return true;
  }
}
