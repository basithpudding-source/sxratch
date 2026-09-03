import test from "node:test";
import assert from "node:assert/strict";

import {
  DAW_SHORTCUT_GROUPS,
  createGuidedTour,
  formatShortcut,
  getShortcut,
  matchShortcut,
  resolveTourTarget,
  shortcutGroupsForDisplay,
} from "../js/daw-guidance.js";

function key(code, overrides = {}) {
  return {
    code,
    key: code,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (name) => values.get(name) ?? null,
    setItem: (name, value) => values.set(name, String(value)),
    values,
  };
}

function fakeRoot(entries = {}) {
  const values = new Map(Object.entries(entries));
  return {
    values,
    querySelector(selector) {
      return values.get(selector) || null;
    },
  };
}

test("shortcut display and event matching share one grouped registry", () => {
  assert.ok(DAW_SHORTCUT_GROUPS.length >= 3);
  assert.equal(getShortcut("edit.undo").title, "Undo");
  assert.equal(formatShortcut("edit.undo", { platform: "Win32" }), "Ctrl + Z");
  assert.equal(formatShortcut("edit.undo", { platform: "MacIntel", compact: true }), "⌘Z");
  assert.equal(
    formatShortcut("edit.redo", { platform: "Win32" }),
    "Ctrl + Y / Ctrl + Shift + Z",
  );

  assert.equal(matchShortcut(key("KeyZ", { ctrlKey: true }), "edit.undo", { platform: "Win32" }), true);
  assert.equal(matchShortcut(key("KeyZ"), "edit.undo", { platform: "Win32" }), false);
  assert.equal(matchShortcut(key("KeyZ", { metaKey: true }), "edit.undo", { platform: "MacIntel" }), true);
  assert.equal(matchShortcut(key("KeyZ", { metaKey: true, shiftKey: true }), "edit.undo", { platform: "MacIntel" }), false);
  assert.equal(matchShortcut(key("ArrowLeft", { altKey: true }), "edit.nudgeLeft"), true);
  assert.equal(matchShortcut(key("ArrowLeft", { altKey: true, shiftKey: true }), "edit.nudgeLeft"), false);

  const display = shortcutGroupsForDisplay({ platform: "Win32" });
  assert.equal(display.find((item) => item.id === "editing").shortcuts[0].label, "Ctrl + Z");
  assert.equal(display.find((item) => item.id === "performance").shortcuts.at(-1).label, "A–L / W–P");
});

test("tour target resolution tolerates invalid and disconnected fallbacks", () => {
  const live = { isConnected: true };
  const root = {
    querySelector(selector) {
      if (selector === "[") throw new SyntaxError("bad selector");
      if (selector === ".gone") return { isConnected: false };
      if (selector === ".live") return live;
      return null;
    },
  };
  assert.equal(resolveTourTarget({ target: ["[", ".gone", ".live"] }, root), live);
  assert.equal(resolveTourTarget({ target: () => { throw new Error("not mounted"); } }, root), null);
});

test("guided tour iteratively skips missing targets and completes", () => {
  const storage = memoryStorage();
  const one = { isConnected: true };
  const three = { isConnected: true };
  const root = fakeRoot({ ".one": one, ".three": three });
  const steps = [
    { id: "one", target: ".one" },
    { id: "two", target: ".missing" },
    { id: "three", target: ".three" },
  ];
  const events = [];
  const tour = createGuidedTour({
    steps,
    root,
    storage,
    storageKey: "tour",
    onChange: (state) => events.push(state.reason),
  });

  assert.equal(tour.start().step.id, "one");
  assert.equal(tour.next().step.id, "three");
  const final = tour.next();
  assert.equal(final.status, "complete");
  assert.equal(final.outcome, "completed");
  assert.deepEqual(events, ["start", "next", "complete"]);
  assert.equal(JSON.parse(storage.getItem("tour")).done, true);
});

test("paused progress resumes, skipped tours restart, and target loss advances", () => {
  const storage = memoryStorage();
  const root = fakeRoot({
    ".one": { isConnected: true },
    ".two": { isConnected: true },
    ".three": { isConnected: true },
  });
  const steps = [
    { id: "one", target: ".one" },
    { id: "two", target: ".two" },
    { id: "three", target: ".three" },
  ];

  const first = createGuidedTour({ steps, root, storage, storageKey: "tour" });
  assert.equal(first.getState().status, "idle");
  first.start();
  first.next();
  assert.equal(first.pause().status, "paused");

  const resumed = createGuidedTour({ steps, root, storage, storageKey: "tour" });
  assert.equal(resumed.resume().step.id, "two");
  root.values.delete(".two");
  assert.equal(resumed.refresh().step.id, "three");
  assert.equal(resumed.skip().outcome, "skipped");
  assert.equal(resumed.resume().reason, "already-complete");
  assert.equal(resumed.restart().step.id, "one");
  assert.equal(resumed.reset().status, "idle");
});

test("an arbitrarily long stale tour finishes without recursion", () => {
  const steps = Array.from({ length: 20_000 }, (_, index) => ({
    id: `missing-${index}`,
    target: `.missing-${index}`,
  }));
  const tour = createGuidedTour({
    steps,
    root: fakeRoot(),
    storage: null,
  });
  assert.equal(tour.start().status, "complete");
});
