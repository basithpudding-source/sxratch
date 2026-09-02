import test from "node:test";
import assert from "node:assert/strict";

import { createDawEngine, scheduleAutomationParam } from "../js/daw-engine.js";

function audioParam(value = 0) {
  return {
    value,
    setTargetAtTime(next) { this.value = next; },
    setValueAtTime(next) { this.value = next; },
    linearRampToValueAtTime(next) { this.value = next; },
  };
}

function audioNode() {
  return {
    connections: [],
    disconnected: false,
    connect(destination) {
      this.connections.push(destination);
      return destination;
    },
    disconnect() {
      this.disconnected = true;
      this.connections.length = 0;
    },
  };
}

/** A deliberately small Web Audio seam for input-lifecycle engine tests. */
function makeAudioContext() {
  const mediaSources = [];
  const nodeWith = (properties = {}) => Object.assign(audioNode(), properties);
  const context = {
    currentTime: 0,
    sampleRate: 44100,
    destination: audioNode(),
    mediaSources,
    createGain() { return nodeWith({ gain: audioParam() }); },
    createBiquadFilter() {
      return nodeWith({
        type: "lowpass",
        frequency: audioParam(),
        Q: audioParam(),
        gain: audioParam(),
      });
    },
    createDynamicsCompressor() {
      return nodeWith({
        threshold: audioParam(), knee: audioParam(), ratio: audioParam(),
        attack: audioParam(), release: audioParam(),
      });
    },
    createAnalyser() {
      return nodeWith({
        fftSize: 0,
        getFloatTimeDomainData(buffer) { buffer.fill(0); },
      });
    },
    createConvolver() { return nodeWith({ buffer: null }); },
    createDelay() { return nodeWith({ delayTime: audioParam() }); },
    createBuffer(channels, length) {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { getChannelData(channel) { return data[channel]; } };
    },
    createMediaStreamSource(stream) {
      const source = nodeWith({ stream });
      mediaSources.push(source);
      return source;
    },
  };
  return context;
}

function makeStream(deviceId) {
  const listeners = new Map();
  const track = {
    deviceId,
    stopped: false,
    stopCalls: 0,
    getSettings() { return { deviceId }; },
    stop() { this.stopped = true; this.stopCalls += 1; },
    addEventListener(type, handler) {
      listeners.set(type, handler);
    },
    emit(type) { listeners.get(type)?.(); },
  };
  return {
    track,
    getTracks() { return [track]; },
    getAudioTracks() { return [track]; },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function installMediaDevices(t, getUserMedia) {
  const prior = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia } },
  });
  t.after(() => {
    if (prior) Object.defineProperty(globalThis, "navigator", prior);
    else delete globalThis.navigator;
  });
}

function makeInputEngine({ onInputStateChange } = {}) {
  const context = makeAudioContext();
  const song = { bpm: 120, tracks: [], master: { gain: 0.9 } };
  const engine = createDawEngine({
    getCtx: () => context,
    getOutput: () => context.destination,
    getSong: () => song,
    getClip: () => null,
    onInputStateChange,
  });
  return { context, engine };
}

test("scheduleAutomationParam samples one scaled curve into the requested time window", () => {
  const calls = [];
  const param = {
    setValueCurveAtTime(curve, start, duration) {
      calls.push({ curve, start, duration });
    },
  };
  const scratch = new Float32Array(5);
  const scheduled = scheduleAutomationParam(
    param,
    [{ b: 0, v: 0 }, { b: 8, v: 1 }],
    0,
    2,
    6,
    (beat) => 10 + beat * 0.5,
    { scale: 0.4, curve: scratch },
  );

  assert.equal(scheduled, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].curve, scratch, "caller-provided curve should be reused");
  assert.equal(calls[0].start, 11);
  assert.equal(calls[0].duration, 2);
  assert.ok(Math.abs(scratch[0] - 0.1) < 1e-6);
  assert.ok(Math.abs(scratch[2] - 0.2) < 1e-6);
  assert.ok(Math.abs(scratch[4] - 0.3) < 1e-6);
});

test("scheduleAutomationParam ignores empty lanes and invalid windows", () => {
  let called = false;
  const param = {
    setValueCurveAtTime() { called = true; },
  };
  assert.equal(scheduleAutomationParam(param, [], 0.5, 0, 1, (beat) => beat), false);
  assert.equal(scheduleAutomationParam(param, [{ b: 0, v: 1 }], 0.5, 2, 1, (beat) => beat), false);
  assert.equal(called, false);
});

test("scheduleAutomationParam degrades to endpoint events without curve support", () => {
  const calls = [];
  const param = {
    setValueAtTime(value, at) { calls.push(["set", value, at]); },
    linearRampToValueAtTime(value, at) { calls.push(["ramp", value, at]); },
  };
  assert.equal(scheduleAutomationParam(
    param,
    [{ b: 0, v: -1 }, { b: 4, v: 1 }],
    0,
    0,
    4,
    (beat) => 20 + beat * 0.25,
  ), true);
  assert.deepEqual(calls, [
    ["set", -1, 20],
    ["ramp", 1, 21],
  ]);
});

test("openInput preserves a working input when the requested replacement fails", async (t) => {
  const original = makeStream("interface-a");
  const denied = new Error("Interface B is unavailable");
  denied.name = "NotFoundError";
  const inputStates = [];
  installMediaDevices(t, async (constraints) => {
    const requested = constraints.audio.deviceId?.exact;
    if (requested === "interface-a") return original;
    throw denied;
  });
  const { engine } = makeInputEngine({
    onInputStateChange: (state, event) => inputStates.push({ state, event }),
  });

  await engine.openInput({ deviceId: "interface-a", monitor: true, inputGain: 0.65 });
  await assert.rejects(
    engine.openInput({ deviceId: "interface-b", monitor: false }),
    (error) => error === denied,
  );

  assert.deepEqual(engine.getInputState(), {
    open: true,
    deviceId: "interface-a",
    requestedDeviceId: "interface-a",
    monitoring: true,
    inputGain: 0.65,
  });
  assert.equal(original.track.stopped, false, "a rejected switch must not interrupt the live interface");
  assert.deepEqual(inputStates.map(({ event }) => event.reason), ["connected"]);

  assert.equal(engine.closeInput(), true);
  assert.equal(original.track.stopped, true, "explicit disconnect still releases the original input");
});

test("openInput discards an older permission response when a newer device request wins", async (t) => {
  const firstRequest = deferred();
  const secondRequest = deferred();
  const stale = makeStream("interface-a");
  const current = makeStream("interface-b");
  installMediaDevices(t, (constraints) => (
    constraints.audio.deviceId?.exact === "interface-a"
      ? firstRequest.promise
      : secondRequest.promise
  ));
  const { context, engine } = makeInputEngine();

  const firstOpen = engine.openInput({ deviceId: "interface-a" });
  const secondOpen = engine.openInput({ deviceId: "interface-b" });
  secondRequest.resolve(current);
  await secondOpen;
  firstRequest.resolve(stale);
  await firstOpen;

  assert.equal(stale.track.stopped, true, "a stale stream must be released as soon as its prompt resolves");
  assert.equal(current.track.stopped, false);
  assert.equal(context.mediaSources.length, 1, "a stale response must not enter the audio graph");
  assert.equal(engine.getInputState().deviceId, "interface-b");
  engine.closeInput();
});

test("closeInput invalidates and releases a permission request that resolves later", async (t) => {
  const pendingRequest = deferred();
  const delayed = makeStream("late-interface");
  installMediaDevices(t, () => pendingRequest.promise);
  const { context, engine } = makeInputEngine();

  const opening = engine.openInput({ deviceId: "late-interface" });
  assert.equal(engine.closeInput(), true);
  pendingRequest.resolve(delayed);
  await opening;

  assert.deepEqual(engine.getInputState(), {
    open: false,
    deviceId: null,
    requestedDeviceId: null,
    monitoring: false,
    inputGain: 1,
  });
  assert.equal(delayed.track.stopped, true);
  assert.equal(context.mediaSources.length, 0, "a disconnected pending request must never create audio nodes");
});
