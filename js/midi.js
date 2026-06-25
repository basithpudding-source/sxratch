// Web MIDI input. Connects a hardware MIDI controller (DJ controller, pad
// controller, keyboard) to Sxratch. Parses raw MIDI into note / control-change /
// pitch-bend callbacks; the app maps those to scratch, crossfader, volumes, EQ,
// transport and sampler pads. No-ops and reports `supported:false` where the Web
// MIDI API is unavailable (e.g. Safari without the flag).

export class MidiInput {
  constructor() {
    this.access = null;
    this.enabled = false;
    this.devices = [];
    this.onStatus = null;     // ({ supported, enabled, devices }) => void
    this.onNote = null;       // (note, velocity 0..1, channel, on) => void
    this.onControl = null;    // (cc, value 0..1, channel) => void
    this.onPitchBend = null;  // (value -1..1, channel) => void
  }

  supported() {
    return typeof navigator !== "undefined" && typeof navigator.requestMIDIAccess === "function";
  }

  async enable() {
    if (!this.supported()) { this._status(); return false; }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
    } catch {
      this._status();
      return false;
    }
    this._bind();
    this.access.onstatechange = () => this._bind();
    this.enabled = true;
    this._status();
    return true;
  }

  _bind() {
    this.devices = [];
    if (!this.access) return;
    for (const input of this.access.inputs.values()) {
      this.devices.push(input.name || "MIDI device");
      input.onmidimessage = (e) => this._message(e.data);
    }
    this._status();
  }

  _status() {
    this.onStatus?.({ supported: this.supported(), enabled: this.enabled, devices: this.devices.slice() });
  }

  /** Parse a raw MIDI message and fan out to the typed callbacks. */
  _message(data) {
    const status = data[0] & 0xf0;
    const channel = data[0] & 0x0f;
    const d1 = data[1] || 0;
    const d2 = data[2] || 0;
    if (status === 0x90 && d2 > 0) this.onNote?.(d1, d2 / 127, channel, true);            // note on
    else if (status === 0x80 || (status === 0x90 && d2 === 0)) this.onNote?.(d1, 0, channel, false); // note off
    else if (status === 0xb0) this.onControl?.(d1, d2 / 127, channel);                    // control change
    else if (status === 0xe0) this.onPitchBend?.((((d2 << 7) | d1) - 8192) / 8192, channel); // pitch bend
  }
}

// Default control map for a generic controller. CC numbers follow a common DJ
// layout; remap any of these live with "MIDI Learn" in Settings.
export const DEFAULT_MIDI_MAP = {
  crossfade: { cc: 8 },
  volA: { cc: 7 }, volB: { cc: 11 },
  eqA: { cc: 1 }, eqB: { cc: 2 },        // a single "mid" sweep per deck
  jogA: { cc: 16 }, jogB: { cc: 17 },     // relative jog wheels -> scratch
};
