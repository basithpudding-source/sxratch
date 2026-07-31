import test from "node:test";
import assert from "node:assert/strict";

import { scheduleAutomationParam } from "../js/daw-engine.js";

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
