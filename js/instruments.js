// Sxratch sampled-instrument engine.
//
// The Song Builder synthesizes every instrument from oscillators (great: zero
// assets, instant, tunable — but unmistakably synthetic). This module adds an
// optional *sampled* backend: real multisampled General MIDI instruments, so a
// "warm pad" or "acoustic bass" actually sounds like one.
//
// Source: MIDI.js-format FluidR3_GM soundfonts — one file of inline base64
// note samples per instrument, fully chromatic (A0..C8). The 14 programs the
// app uses are SELF-HOSTED under samples/FluidR3_GM/ (fetched by
// `npm run samples`, MIT licensed, cached by the service worker so the engine
// works offline after first use), with the gleitz CDN as an automatic
// fallback when a local file is missing. One fetch per instrument; we decode
// only the notes a song uses. No library dependency, no .sf2 parser. The
// synth path stays the default and the always-available fallback.

import { noteNameToMidi, nearest } from "./theory.js";

const LOCAL_BASE = "samples";                                     // same-origin, SW-cacheable
const CDN_BASE = "https://gleitz.github.io/midi-js-soundfonts";   // fallback only

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

// Programs whose notes decay naturally (piano, plucked, bells): after the note
// ends they RING toward their sampled tail instead of being gated — the gate is
// what made real samples sound synthetic. Everything else sustains and gets a
// clean release fade.
const DECAYING = new Set([
  "electric_piano_1", "celesta", "acoustic_guitar_nylon", "acoustic_guitar_steel",
  "acoustic_bass", "electric_bass_finger",
]);

export class SampleBank {
  /** @param {AudioContext} ctx live context used to decode samples (buffers are reusable in offline contexts too). */
  constructor(ctx, opts = {}) {
    this.ctx = ctx;
    this.localBase = opts.localBase ?? LOCAL_BASE; // same-origin first ("" disables)
    this.base = opts.base || CDN_BASE;             // CDN fallback
    this.set = opts.set || "FluidR3_GM";
    this.programs = {};   // name -> { uris:{midi:dataURI}, buffers:Map<midi,{buf,peak}>, sorted:number[] }
    this._indexing = {};  // name -> Promise (in-flight index fetches)
    this.drumKits = {};   // folder -> { buffers:Map<file,AudioBuffer> } | { loading:Promise }
    this.drumsBase = opts.drumsBase || DRUMS_BASE;
  }

  /** Fetch + parse an instrument's note table (cheap; no audio decoded yet). */
  index(program) {
    const have = this.programs[program];
    if (have && have.uris) return Promise.resolve(have);
    if (this._indexing[program]) return this._indexing[program];
    // Anything we feed to the parser must actually BE a soundfont file — a
    // captive portal, 404 page or app-shell fallback would otherwise reach
    // new Function() as HTML.
    const looksLikeSoundfont = (t) => typeof t === "string" && t.slice(0, 400).includes("MIDI.Soundfont");
    const p = (async () => {
      const file = `${this.set}/${program}-mp3.js`;
      let text = null;
      if (this.localBase) { // self-hosted copy first: reliable, offline-cacheable
        try {
          const res = await fetch(`${this.localBase}/${file}`);
          if (res.ok) {
            const t = await res.text();
            if (looksLikeSoundfont(t)) text = t; // else fall through to the CDN
          }
        } catch {}
      }
      if (text == null) {
        const res = await fetch(`${this.base}/${file}`);
        if (!res.ok) throw new Error(`soundfont fetch failed (${res.status}) for ${program}`);
        text = await res.text();
        if (!looksLikeSoundfont(text)) throw new Error("not a soundfont file: " + program);
      }
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
    const clean = () => { delete this._indexing[program]; };
    p.then(clean, clean); // .finally() would mint an unhandled rejected promise on failure
    return p;
  }

  /** Decode (once) the nearest available sample for `midi`. Resolves to {buf,peak} or null. */
  async decodeNote(program, midi) {
    const rec = this.programs[program] && this.programs[program].uris ? this.programs[program] : await this.index(program);
    if (!rec.sorted.length) return null;
    const root = rec.uris[midi] != null ? midi : nearest(rec.sorted, midi);
    let entry = rec.buffers.get(root);
    if (!entry) {
      const buf = await this.ctx.decodeAudioData(dataUriToArrayBuffer(rec.uris[root]));
      // Measure the sample's true peak once — play() normalizes against it, so
      // every program lands at a consistent level regardless of how hot or
      // quiet its source material was mastered.
      let peak = 0;
      for (let c = 0; c < buf.numberOfChannels; c++) {
        const d = buf.getChannelData(c);
        for (let i = 0; i < d.length; i++) { const a = Math.abs(d[i]); if (a > peak) peak = a; }
      }
      entry = { buf, peak: Math.max(0.001, peak) };
      rec.buffers.set(root, entry);
    }
    return entry;
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
    const entry = rec.buffers.get(root);
    if (!entry) return false;

    const ctx = dest.context;
    const src = ctx.createBufferSource();
    src.buffer = entry.buf;
    if (root !== midi) src.playbackRate.value = Math.pow(2, (midi - root) / 12);

    const vel = Math.max(0.02, Math.min(1.25, velocity));
    const g = ctx.createGain();
    // Normalize against the measured sample peak (a fixed makeup gain can't be
    // right for 14 differently-mastered programs): full velocity lands every
    // program at the same target peak as the synth voices.
    const level = vel * Math.min(6, 0.16 / entry.peak);
    const end = when + Math.max(0.05, dur);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(level, when + 0.006);

    let head = src;
    if (vel < 0.95) { // softer hits are darker, like a real instrument
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = 1000 + 14000 * Math.pow(vel, 1.6);
      lp.Q.value = 0.5;
      head.connect(lp);
      head = lp;
    }

    if (DECAYING.has(program)) {
      // Piano/pluck/bell family: let the sampled tail ring past the note end
      // with only a slow fade, so decays sound natural instead of gated.
      g.gain.setTargetAtTime(0.0001, end, 0.28);
      head.connect(g).connect(dest);
      src.start(when);
      src.stop(Math.min(when + entry.buf.duration / (src.playbackRate.value || 1), end + 1.5));
    } else {
      // Sustained family (pads, strings, organ, flute, saw/square leads):
      // clean release fade past the grid line.
      g.gain.setTargetAtTime(0.0001, end, 0.11);
      head.connect(g).connect(dest);
      src.start(when);
      src.stop(end + 0.6);
    }
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
          const res = await fetch(`${this.drumsBase}/${folder}/${f}.mp3`);
          if (!res.ok) return;
          buffers.set(f, await this.ctx.decodeAudioData(await res.arrayBuffer()));
        } catch {}
      }));
      // A fully-failed load (offline, CDN down) must NOT be cached as "this
      // kit has no drums" forever — throw so the next attempt retries.
      if (!buffers.size) throw new Error("drum kit unavailable: " + kitId);
      const rec = { buffers };
      this.drumKits[folder] = rec;
      return rec;
    })();
    this.drumKits[folder] = { loading: promise };
    promise.catch(() => {
      const cur = this.drumKits[folder];
      if (cur && cur.loading === promise) delete this.drumKits[folder];
    });
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
