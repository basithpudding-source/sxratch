// Unit tests for the versioned localStorage envelope (js/store.js).
// Run with: npm test

import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

// Minimal localStorage shim for node.
const mem = new Map();
globalThis.localStorage = {
  getItem: (k) => (mem.has(k) ? mem.get(k) : null),
  setItem: (k, v) => { mem.set(k, String(v)); },
  removeItem: (k) => { mem.delete(k); },
};

const { readVersioned, readVersionedRecord, writeVersioned } = await import("../js/store.js");

beforeEach(() => mem.clear());

test("round trip: write then read returns the data", () => {
  assert.ok(writeVersioned("k", 1, { a: 1, list: [1, 2] }));
  assert.deepEqual(readVersioned("k", 1), { a: 1, list: [1, 2] });
});

test("optional envelope metadata round trips without leaking into data", () => {
  const metadata = { dawFallback: { failedAt: 1234, baseRevision: 7 } };
  assert.ok(writeVersioned("k", 1, { bpm: 120 }, { metadata }));
  assert.deepEqual(readVersioned("k", 1), { bpm: 120 });
  assert.deepEqual(readVersionedRecord("k", 1), {
    data: { bpm: 120 },
    metadata,
  });
});

test("legacy raw value is treated as v0 and migrated forward", () => {
  mem.set("k", JSON.stringify({ bpm: 90, sections: [] })); // pre-envelope save
  const migrations = [(d) => ({ ...d, migrated: true })];
  assert.deepEqual(readVersioned("k", 1, migrations), { bpm: 90, sections: [], migrated: true });
});

test("multi-step migrations run in order", () => {
  mem.set("k", JSON.stringify({ n: 1 }));
  const migrations = [(d) => ({ n: d.n + 1 }), (d) => ({ n: d.n * 10 })];
  assert.deepEqual(readVersioned("k", 2, migrations), { n: 20 });
});

test("data written at the current version skips migrations", () => {
  writeVersioned("k", 2, { n: 5 });
  const explode = () => { throw new Error("must not run"); };
  assert.deepEqual(readVersioned("k", 2, [explode, explode]), { n: 5 });
});

test("newer-than-known version is returned best-effort, not destroyed", () => {
  mem.set("k", JSON.stringify({ __sxv: 9, data: { future: true } }));
  assert.deepEqual(readVersioned("k", 1), { future: true });
});

test("corrupted JSON reads as null (never throws)", () => {
  mem.set("k", "{not json");
  assert.equal(readVersioned("k", 1), null);
});

test("a failing migration reads as null (never throws)", () => {
  mem.set("k", JSON.stringify({ x: 1 }));
  assert.equal(readVersioned("k", 1, [() => { throw new Error("bad"); }]), null);
});

test("absent key reads as null", () => {
  assert.equal(readVersioned("nope", 1), null);
});

test("quota failure returns false and calls onQuota", () => {
  const boom = new Error("QuotaExceededError");
  const orig = globalThis.localStorage.setItem;
  globalThis.localStorage.setItem = () => { throw boom; };
  let seen = null;
  assert.equal(writeVersioned("k", 1, { a: 1 }, { onQuota: (e) => { seen = e; } }), false);
  assert.equal(seen, boom);
  globalThis.localStorage.setItem = orig;
});
