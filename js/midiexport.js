// Sxratch MIDI export — a minimal, dependency-free Standard MIDI File writer.
//
// encodeMidi() takes a plain description of tracks/notes in absolute ticks and
// returns the bytes of a format-1 SMF: track 0 carries tempo + time-signature
// meta events, each further track carries one instrument's notes. Everything a
// DAW needs to reconstruct a PAD arrangement (drums on channel 10).

/** Variable-length quantity (big-endian 7-bit groups, MSB set on all but last). */
export function vlq(n) {
  n = Math.max(0, n | 0);
  const out = [n & 0x7f];
  while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80);
  return out;
}

const str = (s) => [...s].map((c) => c.charCodeAt(0) & 0x7f);
const u32 = (n) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
const u16 = (n) => [(n >>> 8) & 255, n & 255];

/** Sort order inside one tick: meta first, then note-offs, then note-ons. */
const eventOrder = (bytes) =>
  bytes[0] === 0xff ? 0 : (bytes[0] & 0xf0) === 0x80 ? 1 : 2;

function trackChunk(events) {
  const evs = [...events].sort(
    (a, b) => a.tick - b.tick || eventOrder(a.bytes) - eventOrder(b.bytes)
  );
  const out = [];
  let last = 0;
  for (const e of evs) {
    out.push(...vlq(e.tick - last), ...e.bytes);
    last = e.tick;
  }
  out.push(...vlq(0), 0xff, 0x2f, 0x00); // end of track
  return [...str("MTrk"), ...u32(out.length), ...out];
}

/**
 * @param {object} data
 *   ticksPerQuarter — SMF division (default 480)
 *   tempoBpm        — single fixed tempo (used when `tempos` is absent)
 *   tempos          — [{tick, bpm}] tempo-change list (per-section BPM)
 *   timeSigs        — [{tick, num, den}] (den must be a power of two)
 *   markers         — [{tick, name}] conductor-track marker events
 *   tracks          — [{name, channel (0-15, 9 = drums), notes:[{tick,dur,note,vel}]}]
 * @returns {Uint8Array} the .mid file bytes
 */
export function encodeMidi({ ticksPerQuarter = 480, tempoBpm = 120, tempos = null, timeSigs = [], markers = [], tracks = [] }) {
  const chunks = [];

  // Track 0 — conductor: tempo(s) + time signatures.
  const meta = [];
  const tempoList = tempos && tempos.length ? tempos : [{ tick: 0, bpm: tempoBpm }];
  for (const t of tempoList) {
    const mpq = Math.max(1, Math.round(60e6 / (t.bpm || 120)));
    meta.push({ tick: Math.max(0, Math.round(t.tick)), bytes: [0xff, 0x51, 0x03, (mpq >> 16) & 255, (mpq >> 8) & 255, mpq & 255] });
  }
  for (const ts of timeSigs) {
    const dd = Math.max(0, Math.round(Math.log2(ts.den || 4)));
    meta.push({ tick: Math.max(0, Math.round(ts.tick)), bytes: [0xff, 0x58, 0x04, ts.num & 255, dd, 24, 8] });
  }
  for (const marker of markers || []) {
    const name = str(String(marker.name || "Marker")).slice(0, 60);
    meta.push({
      tick: Math.max(0, Math.round(marker.tick)),
      bytes: [0xff, 0x06, name.length, ...name],
    });
  }
  chunks.push(trackChunk(meta));

  for (const t of tracks) {
    const evs = [];
    if (t.name) {
      const name = str(t.name).slice(0, 60);
      evs.push({ tick: 0, bytes: [0xff, 0x03, name.length, ...name] });
    }
    const ch = (t.channel ?? 0) & 0x0f;
    for (const n of t.notes || []) {
      const note = Math.max(0, Math.min(127, n.note | 0));
      const vel = Math.max(1, Math.min(127, n.vel | 0));
      const on = Math.max(0, Math.round(n.tick));
      const off = on + Math.max(1, Math.round(n.dur));
      evs.push({ tick: on, bytes: [0x90 | ch, note, vel] });
      evs.push({ tick: off, bytes: [0x80 | ch, note, 0] });
    }
    chunks.push(trackChunk(evs));
  }

  const bytes = [
    ...str("MThd"), ...u32(6),
    ...u16(1),                    // format 1
    ...u16(chunks.length),
    ...u16(ticksPerQuarter),
  ];
  for (const c of chunks) bytes.push(...c);
  return new Uint8Array(bytes);
}
