// WAV encoding — shared by the PAD song export (js/songbuilder.js) and the
// global mix recorder (js/recorder.js).

import { floatToInt16 } from "./theory.js";

/** Encode an AudioBuffer to a 16-bit PCM WAV blob. */
export function bufferToWav(buf) {
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
