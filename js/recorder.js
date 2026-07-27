// Shared mix recorder — ONE MediaRecorder implementation for both the topbar
// REC button and the Practice-mode freestyle recorder (previously two
// duplicated copies, each with its own always-on MediaStreamDestination).
//
// Taps `engine.limiter` — post-limiter but PRE master volume, so recordings
// come out at full scale no matter where the monitor volume knob sits.
// (The master chain is masterBus → limiter → master → destination.)

const EXT_BY_MIME = [
  [/webm/i, "webm"],
  [/mp4|aac|m4a/i, "m4a"],
  [/ogg/i, "ogg"],
];

/**
 * @param {import("./audio-engine.js").AudioEngine} engine
 * @returns {{ start(): boolean, stop(): Promise<{blob: Blob, mimeType: string, ext: string}|null>, recording: boolean, onerror: ((msg: string) => void)|null }|null}
 *          null when MediaRecorder is unavailable in this browser.
 */
export function createMixRecorder(engine) {
  if (!window.MediaRecorder) return null;
  const dest = engine.ctx.createMediaStreamDestination();
  engine.limiter.connect(dest);

  let rec = null, chunks = [];
  const api = {
    recording: false,
    /** Called on unsupported/failed starts AND mid-stream failures. */
    onerror: null,

    start() {
      if (api.recording) return true;
      chunks = [];
      try {
        rec = new MediaRecorder(dest.stream);
      } catch (err) {
        console.error("recorder start failed", err);
        api.onerror?.("Could not start recording");
        rec = null;
        return false;
      }
      rec.ondataavailable = (e) => { if (e.data && e.data.size > 0) chunks.push(e.data); };
      rec.onerror = (e) => {
        console.error("recorder error", e.error || e);
        api.recording = false;
        api.onerror?.("Recording failed — the captured audio may be incomplete");
      };
      rec.start();
      api.recording = true;
      return true;
    },

    stop() {
      return new Promise((resolve) => {
        if (!rec || rec.state === "inactive") { api.recording = false; resolve(null); return; }
        rec.onstop = () => {
          api.recording = false;
          const mimeType = rec.mimeType || "audio/webm";
          const blob = new Blob(chunks, { type: mimeType });
          const ext = (EXT_BY_MIME.find(([re]) => re.test(mimeType)) || [null, "webm"])[1];
          resolve(blob.size > 0 ? { blob, mimeType, ext } : null);
        };
        try { rec.stop(); } catch { api.recording = false; resolve(null); }
      });
    },
  };
  return api;
}
