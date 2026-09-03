import test from "node:test";
import assert from "node:assert/strict";

import { samplesToEvict } from "../js/idb-store.js";

test("sample eviction never removes pinned DAW project audio", () => {
  const records = [
    { id: "dawclip:take", bytes: 500, savedAt: 1, pinned: true },
    { id: "pad-old", bytes: 60, savedAt: 2 },
    { id: "pad-new", bytes: 60, savedAt: 3 },
  ];
  assert.deepEqual(samplesToEvict(records, 100), ["pad-old"]);
});

test("pinned audio does not consume the sampler eviction budget", () => {
  const records = [
    { id: "dawclip:long-take", bytes: 10_000, savedAt: 1, pinned: true },
    { id: "pad-a", bytes: 40, savedAt: 2 },
    { id: "pad-b", bytes: 40, savedAt: 3 },
  ];
  assert.deepEqual(samplesToEvict(records, 100), []);
});

test("sample eviction removes oldest unpinned records first", () => {
  const records = [
    { id: "new", bytes: 40, savedAt: 30 },
    { id: "old", bytes: 40, savedAt: 10 },
    { id: "middle", bytes: 40, savedAt: 20 },
  ];
  assert.deepEqual(samplesToEvict(records, 60), ["old", "middle"]);
});
