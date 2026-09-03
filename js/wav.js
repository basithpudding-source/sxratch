// WAV encoding — shared by PAD bounces/exports and the global mix recorder.
//
// `bufferToWav()` deliberately remains synchronous for existing download and
// recorder callers. PAD exports can use `bufferToWavAsync()` instead: it
// copies the channel data (so the source AudioBuffer remains playable) and
// writes PCM in a module worker when one is available.

import { floatToInt16 } from "./theory.js";

export const WAV_MIME_TYPE = "audio/wav";

const WAV_HEADER_BYTES = 44;
const PCM16_BYTES_PER_SAMPLE = 2;
const UINT32_MAX = 0xffffffff;

/**
 * Encode interleaved 16-bit PCM WAV bytes from channel-major Float32 samples.
 *
 * This stays exported because `wav-worker.js` uses the exact same encoder.
 * `channels` are read only; the returned ArrayBuffer is safe to transfer.
 */
export function encodePcm16Wav(channels, sampleRate, length = channels?.[0]?.length) {
  const meta = validateChannels(channels, sampleRate, length);
  const { channelCount, frameCount, byteLength, byteRate } = meta;
  const data = new DataView(new ArrayBuffer(WAV_HEADER_BYTES + byteLength));
  const writeText = (offset, text) => {
    for (let i = 0; i < text.length; i++) data.setUint8(offset + i, text.charCodeAt(i));
  };

  writeText(0, "RIFF");
  data.setUint32(4, 36 + byteLength, true);
  writeText(8, "WAVE");
  writeText(12, "fmt ");
  data.setUint32(16, 16, true);
  data.setUint16(20, 1, true); // PCM
  data.setUint16(22, channelCount, true);
  data.setUint32(24, sampleRate, true);
  data.setUint32(28, byteRate, true);
  data.setUint16(32, channelCount * PCM16_BYTES_PER_SAMPLE, true);
  data.setUint16(34, 16, true);
  writeText(36, "data");
  data.setUint32(40, byteLength, true);

  let offset = WAV_HEADER_BYTES;
  for (let frame = 0; frame < frameCount; frame++) {
    for (let channel = 0; channel < channelCount; channel++) {
      data.setInt16(offset, floatToInt16(channels[channel][frame]), true);
      offset += PCM16_BYTES_PER_SAMPLE;
    }
  }
  return data.buffer;
}

/** Encode an AudioBuffer to a 16-bit PCM WAV blob. Kept for compatibility. */
export function bufferToWav(buffer) {
  const { channels, sampleRate, length } = readAudioBuffer(buffer);
  return new Blob([encodePcm16Wav(channels, sampleRate, length)], { type: WAV_MIME_TYPE });
}

/** Whether this browser can move PCM encoding into a module worker. */
export function supportsWavWorker() {
  return typeof Worker === "function";
}

/**
 * Encode an AudioBuffer without monopolising the UI thread where module
 * workers are supported. The AudioBuffer's backing storage is never
 * transferred (doing so could detach it); the worker receives copies instead.
 *
 * @param {AudioBuffer} buffer
 * @param {{ useWorker?: boolean, fallback?: boolean, signal?: AbortSignal }} options
 * @returns {Promise<Blob>}
 */
export async function bufferToWavAsync(buffer, options = {}) {
  const source = readAudioBuffer(buffer); // validate before choosing a path
  const { useWorker = true, fallback = true, signal } = options;
  throwIfAborted(signal);

  if (useWorker && supportsWavWorker()) {
    try {
      return await encodeWithWorker(source, signal);
    } catch (error) {
      // An abort is intentional and must not quietly produce an export.
      if (!fallback || isAbortError(error)) throw error;
    }
  }

  // Keep the async contract even in constrained browsers. A task boundary
  // gives the transport/status UI a chance to paint before the legacy encoder
  // performs its synchronous fallback.
  await nextTask();
  throwIfAborted(signal);
  return new Blob([encodePcm16Wav(source.channels, source.sampleRate, source.length)], { type: WAV_MIME_TYPE });
}

function readAudioBuffer(buffer) {
  if (!buffer || typeof buffer.getChannelData !== "function") {
    throw new TypeError("Expected an AudioBuffer-like value with getChannelData().");
  }
  const channelCount = Number(buffer.numberOfChannels);
  const length = Number(buffer.length);
  const sampleRate = Number(buffer.sampleRate);
  if (!Number.isSafeInteger(channelCount) || channelCount < 1 || channelCount > 0xffff) {
    throw new RangeError("AudioBuffer must have between 1 and 65535 channels.");
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("AudioBuffer length must be a non-negative safe integer.");
  }
  const channels = Array.from({ length: channelCount }, (_, index) => buffer.getChannelData(index));
  validateChannels(channels, sampleRate, length);
  return { channels, sampleRate, length };
}

function validateChannels(channels, sampleRate, length) {
  if (!Array.isArray(channels) || channels.length < 1 || channels.length > 0xffff) {
    throw new RangeError("WAV encoding requires between 1 and 65535 Float32 channels.");
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new RangeError("WAV frame length must be a non-negative safe integer.");
  }
  if (!Number.isSafeInteger(sampleRate) || sampleRate < 1 || sampleRate > UINT32_MAX) {
    throw new RangeError("WAV sample rate must be a positive unsigned 32-bit integer.");
  }
  for (const channel of channels) {
    if (!(channel instanceof Float32Array) || channel.length < length) {
      throw new TypeError("Each WAV channel must be a Float32Array with the requested frame length.");
    }
  }

  const channelCount = channels.length;
  const byteLength = length * channelCount * PCM16_BYTES_PER_SAMPLE;
  const byteRate = sampleRate * channelCount * PCM16_BYTES_PER_SAMPLE;
  if (!Number.isSafeInteger(byteLength) || byteLength > UINT32_MAX - 36 ||
      !Number.isSafeInteger(byteRate) || byteRate > UINT32_MAX) {
    throw new RangeError("AudioBuffer is too large for a 16-bit PCM WAV file.");
  }
  return { channelCount, frameCount: length, byteLength, byteRate };
}

function encodeWithWorker(source, signal) {
  let worker;
  try {
    worker = new Worker(new URL("./wav-worker.js", import.meta.url), { type: "module" });
  } catch (error) {
    return Promise.reject(error);
  }

  // A transferable copy avoids detaching the AudioBuffer being bounced. This
  // is substantially cheaper than PCM packing for a long mix and lets the
  // worker own the expensive interleave + quantise pass.
  const copies = source.channels.map((channel) => channel.slice(0, source.length));
  const transfer = copies.map((channel) => channel.buffer);

  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      signal?.removeEventListener("abort", onAbort);
      try { worker.terminate(); } catch {}
    };
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const onAbort = () => finish(reject, createAbortError());

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event) => {
      const message = event.data || {};
      if (message.type === "result" && message.data instanceof ArrayBuffer) {
        finish(resolve, new Blob([message.data], { type: WAV_MIME_TYPE }));
      } else {
        finish(reject, new Error(message.message || "WAV worker returned an invalid response."));
      }
    };
    worker.onerror = (event) => finish(reject, event.error || new Error(event.message || "WAV worker failed."));
    worker.onmessageerror = () => finish(reject, new Error("WAV worker message could not be decoded."));
    try {
      worker.postMessage({ type: "encode", channels: transfer, sampleRate: source.sampleRate, length: source.length }, transfer);
    } catch (error) {
      finish(reject, error);
    }
  });
}

function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

function createAbortError() {
  try { return new DOMException("WAV export was cancelled.", "AbortError"); } catch {
    const error = new Error("WAV export was cancelled.");
    error.name = "AbortError";
    return error;
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw createAbortError();
}

function isAbortError(error) {
  return error?.name === "AbortError";
}
