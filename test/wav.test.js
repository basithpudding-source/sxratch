import test from "node:test";
import assert from "node:assert/strict";

import { bufferToWav, bufferToWavAsync, encodePcm16Wav, WAV_MIME_TYPE } from "../js/wav.js";

function audioBuffer(channels, sampleRate = 48000) {
  return {
    numberOfChannels: channels.length,
    length: channels[0].length,
    sampleRate,
    getChannelData(index) { return channels[index]; },
  };
}

test("encodePcm16Wav writes a valid stereo PCM header and interleaves samples", () => {
  const left = new Float32Array([0, 1, -1]);
  const right = new Float32Array([0.5, -0.5, 0.25]);
  const view = new DataView(encodePcm16Wav([left, right], 48000));

  assert.equal(new TextDecoder().decode(new Uint8Array(view.buffer, 0, 4)), "RIFF");
  assert.equal(new TextDecoder().decode(new Uint8Array(view.buffer, 8, 4)), "WAVE");
  assert.equal(view.getUint16(22, true), 2);
  assert.equal(view.getUint32(24, true), 48000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 12);
  assert.deepEqual(
    [44, 46, 48, 50, 52, 54].map((offset) => view.getInt16(offset, true)),
    [0, 16383, 32767, -16384, -32768, 8191]
  );
});

test("bufferToWav preserves its synchronous Blob API", async () => {
  const wav = bufferToWav(audioBuffer([new Float32Array([0, 0.25])], 44100));
  assert.equal(wav.type, WAV_MIME_TYPE);
  assert.equal(wav.size, 48);
  const header = new DataView(await wav.arrayBuffer());
  assert.equal(header.getUint32(24, true), 44100);
});

test("bufferToWavAsync has a cancellation-safe no-worker fallback", async () => {
  const buffer = audioBuffer([new Float32Array([0, -0.25])]);
  const wav = await bufferToWavAsync(buffer, { useWorker: false });
  assert.equal(wav.type, WAV_MIME_TYPE);
  assert.equal(wav.size, 48);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    bufferToWavAsync(buffer, { useWorker: false, signal: controller.signal }),
    { name: "AbortError" }
  );
});

test("WAV encoder rejects metadata that exceeds RIFF's 32-bit field limits", () => {
  assert.throws(
    () => encodePcm16Wav([new Float32Array(0)], 0xffffffff, 0),
    /too large/
  );
});
