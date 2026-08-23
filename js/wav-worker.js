// PCM packing runs here so a PAD bounce/export keeps the main thread
// responsive. This worker receives transferable copies of AudioBuffer channel
// data; it never owns or detaches the playback buffer itself.

import { encodePcm16Wav } from "./wav.js";

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type !== "encode") return;
  try {
    if (!Array.isArray(message.channels)) throw new TypeError("WAV worker expected channel buffers.");
    const channels = message.channels.map((channel) => new Float32Array(channel));
    const data = encodePcm16Wav(channels, message.sampleRate, message.length);
    self.postMessage({ type: "result", data }, [data]);
  } catch (error) {
    self.postMessage({ type: "error", message: error?.message || "WAV encoding failed." });
  }
};
