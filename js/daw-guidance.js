// DAW guidance primitives.
//
// This module deliberately has no DOM side effects. `daw.js` can use the same
// shortcut records for its key handler and help overlay, and can render tour
// snapshots with the existing Studio UI.

const binding = (code, modifiers = {}) => Object.freeze({ code, ...modifiers });

const shortcut = (id, title, bindings, extra = {}) => Object.freeze({
  id,
  title,
  bindings: Object.freeze(bindings),
  ...extra,
});

const group = (id, title, shortcuts) => Object.freeze({
  id,
  title,
  shortcuts: Object.freeze(shortcuts),
});

/**
 * The Studio shortcut source of truth.
 *
 * `scope` is informational and lets a help surface distinguish arrangement
 * shortcuts from controls that only apply while a piano-roll note has focus.
 * A handler can use `matchShortcut(event, "edit.undo")` rather than restating
 * modifier rules.
 */
export const DAW_SHORTCUT_GROUPS = Object.freeze([
  group("transport", "Transport", [
    shortcut("transport.toggle", "Play / stop", [binding("Space")]),
    shortcut("transport.start", "Jump to start", [binding("Home")]),
    shortcut("transport.end", "Jump to song end", [binding("End")]),
    shortcut("transport.marker", "Add marker", [binding("KeyM")]),
  ]),
  group("editing", "Arrangement editing", [
    shortcut("edit.undo", "Undo", [binding("KeyZ", { mod: true })]),
    shortcut("edit.redo", "Redo", [
      binding("KeyY", { mod: true }),
      binding("KeyZ", { mod: true, shift: true }),
    ]),
    shortcut("edit.selectAll", "Select every region", [binding("KeyA", { mod: true })]),
    shortcut("edit.copy", "Copy regions", [binding("KeyC", { mod: true })]),
    shortcut("edit.cut", "Cut regions", [binding("KeyX", { mod: true })]),
    shortcut("edit.paste", "Paste regions", [binding("KeyV", { mod: true })]),
    shortcut("edit.duplicate", "Duplicate regions", [binding("KeyD", { mod: true })]),
    shortcut("edit.delete", "Delete selection", [binding("Delete"), binding("Backspace")]),
    shortcut("edit.open", "Open selected region", [binding("Enter")]),
    shortcut("edit.clear", "Close editor / clear selection", [binding("Escape")]),
    shortcut("edit.quantize", "Quantize selection", [binding("KeyQ")]),
    shortcut("edit.nudgeLeft", "Nudge left by grid", [binding("ArrowLeft", { alt: true })]),
    shortcut("edit.nudgeRight", "Nudge right by grid", [binding("ArrowRight", { alt: true })]),
    shortcut("edit.nudgeBarLeft", "Nudge left by bar", [binding("ArrowLeft", { alt: true, shift: true })]),
    shortcut("edit.nudgeBarRight", "Nudge right by bar", [binding("ArrowRight", { alt: true, shift: true })]),
  ]),
  group("performance", "Keyboard performance", [
    shortcut("performance.octaveDown", "Octave down", [binding("KeyZ")]),
    shortcut("performance.octaveUp", "Octave up", [binding("KeyX")]),
    shortcut("performance.notes", "Play notes", [], { displayLabel: "A–L / W–P" }),
  ]),
  group("piano-roll", "Piano roll", [
    shortcut("roll.move", "Move selected notes", [], {
      scope: "piano-roll",
      displayLabel: "Arrow keys",
    }),
    shortcut("roll.resize", "Shorten / lengthen notes", [
      binding("ArrowLeft", { shift: true }),
      binding("ArrowRight", { shift: true }),
    ], { scope: "piano-roll" }),
    shortcut("roll.transpose", "Transpose notes", [
      binding("ArrowUp"),
      binding("ArrowDown"),
    ], { scope: "piano-roll" }),
    shortcut("roll.delete", "Delete selected notes", [
      binding("Delete"),
      binding("Backspace"),
    ], { scope: "piano-roll" }),
  ]),
  group("help", "Help", [
    shortcut("help.shortcuts", "Show this shortcut guide", [
      binding("Slash", { shift: true }),
    ], { displayLabel: "?" }),
  ]),
]);

export const DAW_SHORTCUTS = Object.freeze(
  DAW_SHORTCUT_GROUPS.flatMap((item) => item.shortcuts),
);

const SHORTCUT_BY_ID = new Map(DAW_SHORTCUTS.map((item) => [item.id, item]));

const KEY_LABELS = Object.freeze({
  Space: "Space",
  Enter: "Enter",
  Escape: "Esc",
  Backspace: "Backspace",
  Delete: "Delete",
  Home: "Home",
  End: "End",
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
});

export function getShortcut(id) {
  return SHORTCUT_BY_ID.get(id) || null;
}

export function isApplePlatform(platform = defaultPlatform()) {
  return /Mac|iPhone|iPad|iPod|darwin/i.test(String(platform || ""));
}

/**
 * Format one binding, a shortcut record, or a shortcut id for display.
 */
export function formatShortcut(value, {
  platform = defaultPlatform(),
  separator = " + ",
  alternatives = " / ",
  compact = false,
} = {}) {
  const item = typeof value === "string" ? getShortcut(value) : value;
  if (!item) return "";
  if (item.displayLabel) return item.displayLabel;
  const bindings = Array.isArray(item.bindings) ? item.bindings : [item];
  return bindings
    .map((entry) => formatBinding(entry, { platform, separator, compact }))
    .filter(Boolean)
    .join(alternatives);
}

export function shortcutGroupsForDisplay(options = {}) {
  return DAW_SHORTCUT_GROUPS.map((item) => ({
    id: item.id,
    title: item.title,
    shortcuts: item.shortcuts.map((entry) => ({
      id: entry.id,
      title: entry.title,
      scope: entry.scope || "studio",
      label: formatShortcut(entry, options),
    })),
  }));
}

/**
 * Exact keyboard-event matching. Unspecified modifiers are treated as false,
 * which prevents Ctrl+Z from also matching plain Z and keeps conflicts
 * deterministic.
 */
export function matchShortcut(event, value, { platform = defaultPlatform() } = {}) {
  const item = typeof value === "string" ? getShortcut(value) : value;
  if (!event || !item) return false;
  const bindings = Array.isArray(item.bindings) ? item.bindings : [item];
  return bindings.some((entry) => matchBinding(event, entry, platform));
}

export function matchBinding(event, entry, platform = defaultPlatform()) {
  if (!entry || !event) return false;
  const codeMatches = entry.code
    ? event.code === entry.code
    : entry.key
      ? String(event.key).toLowerCase() === String(entry.key).toLowerCase()
      : false;
  if (!codeMatches) return false;

  const apple = isApplePlatform(platform);
  const wantsCtrl = !!entry.ctrl || (!!entry.mod && !apple);
  const wantsMeta = !!entry.meta || (!!entry.mod && apple);
  if (wantsCtrl !== !!event.ctrlKey || wantsMeta !== !!event.metaKey) return false;
  if (!!entry.alt !== !!event.altKey) return false;
  if (!!entry.shift !== !!event.shiftKey) return false;
  return true;
}

function formatBinding(entry, { platform, separator, compact }) {
  if (!entry) return "";
  const apple = isApplePlatform(platform);
  const parts = [];
  if (entry.mod) parts.push(apple ? (compact ? "⌘" : "Command") : "Ctrl");
  if (entry.alt) parts.push(apple ? (compact ? "⌥" : "Option") : "Alt");
  if (entry.shift) parts.push(apple ? (compact ? "⇧" : "Shift") : "Shift");
  if (entry.ctrl) parts.push(apple && compact ? "⌃" : "Ctrl");
  if (entry.meta) parts.push(apple && compact ? "⌘" : "Meta");
  const key = entry.label || KEY_LABELS[entry.code] || codeLabel(entry.code || entry.key);
  if (key) parts.push(key);
  return compact && apple ? parts.join("") : parts.join(separator);
}

function codeLabel(code) {
  const value = String(code || "");
  if (/^Key[A-Z]$/.test(value)) return value.slice(3);
  if (/^Digit[0-9]$/.test(value)) return value.slice(5);
  return value;
}

function defaultPlatform() {
  try {
    return globalThis.navigator?.userAgentData?.platform
      || globalThis.navigator?.platform
      || "";
  } catch {
    return "";
  }
}

const tourStep = (id, title, body, target) => Object.freeze({
  id,
  title,
  body,
  target: Object.freeze(Array.isArray(target) ? target : [target]),
});

export const DEFAULT_DAW_TOUR_STEPS = Object.freeze([
  tourStep(
    "studio",
    "Your Studio",
    "Arrange recordings, instruments and drums on one musical timeline.",
    ["#daw", ".daw"],
  ),
  tourStep(
    "transport",
    "Transport",
    "Play, record, loop and count in from here. Space toggles playback.",
    ["#daw-play", ".daw-transport"],
  ),
  tourStep(
    "tracks",
    "Track controls",
    "Arm, mute, solo, rename and reorder each track from its header.",
    ["#daw-heads-scroll .daw-head", "#daw-heads"],
  ),
  tourStep(
    "arrangement",
    "Arrangement timeline",
    "Draw regions, drag to move them, resize their edges and drag the ruler to loop.",
    ["#daw-timeline", "#daw-lanes"],
  ),
  tourStep(
    "edit-tools",
    "Edit tools",
    "Switch between selecting, drawing and splitting regions.",
    [".daw-tools", ".daw-transport"],
  ),
  tourStep(
    "bottom-panels",
    "Detailed editors",
    "Open the piano roll, playable keys and device controls without leaving the arrangement.",
    [".daw-bottom-tabs", ".daw-bottom"],
  ),
  tourStep(
    "snap",
    "Snap and follow",
    "Choose a rhythmic grid, control zoom and keep the playhead in view.",
    ["#daw-snap", ".daw-status"],
  ),
  tourStep(
    "export",
    "Share your track",
    "Use File to bounce audio, export stems or MIDI, and send the result to a deck.",
    [".daw-file", ".daw-transport-utility"],
  ),
]);

const TOUR_STATE_VERSION = 1;
export const DEFAULT_DAW_TOUR_STORAGE_KEY = "sxratch.daw-tour.v1";

/**
 * Resolve the first connected target supplied by a tour step.
 *
 * A target may be a selector, an element-like object, a resolver function, or
 * an array of fallbacks. Invalid selectors and resolver failures are treated
 * as missing targets so a stale step cannot strand the tour.
 */
export function resolveTourTarget(step, root = defaultRoot()) {
  const candidates = Array.isArray(step?.target) ? step.target : [step?.target ?? step?.selector];
  for (const candidate of candidates) {
    try {
      let target = null;
      if (typeof candidate === "function") target = candidate({ root, step });
      else if (typeof candidate === "string") target = root?.querySelector?.(candidate) || null;
      else target = candidate || null;
      if (target && target.isConnected !== false) return target;
    } catch {
      // Invalid selectors and optional UI that is not ready are both skippable.
    }
  }
  return null;
}

/**
 * Create a persistent, headless guided-tour controller.
 *
 * The renderer receives immutable-ish snapshots through `onChange` or
 * `subscribe`. Call `pause()` for "Not now" (progress is resumable), `skip()`
 * to suppress automatic prompts, and `restart()` to start over even after a
 * completed/skipped tour.
 */
export function createGuidedTour({
  steps = DEFAULT_DAW_TOUR_STEPS,
  root = defaultRoot(),
  storage = defaultStorage(),
  storageKey = DEFAULT_DAW_TOUR_STORAGE_KEY,
  onChange,
} = {}) {
  const list = Array.from(steps || []).filter((step) => step && step.id);
  const listeners = new Set();
  if (typeof onChange === "function") listeners.add(onChange);

  const saved = readTourState(storage, storageKey);
  let index = restoreIndex(list, saved);
  let active = false;
  let done = !!saved.done;
  let started = !!saved.started || !!saved.done;
  let outcome = saved.outcome || (done ? "completed" : null);
  let currentTarget = null;

  const rootNow = () => typeof root === "function" ? root() : root;

  function snapshot(reason = "snapshot") {
    return Object.freeze({
      reason,
      status: active ? "active" : done ? "complete" : started ? "paused" : "idle",
      active,
      done,
      outcome,
      index,
      total: list.length,
      step: index >= 0 ? list[index] || null : null,
      target: active ? currentTarget : null,
      canGoBack: active && findAvailable(index - 1, -1) !== null,
    });
  }

  function emit(reason) {
    const value = snapshot(reason);
    for (const listener of [...listeners]) listener(value);
    return value;
  }

  function persist() {
    writeTourState(storage, storageKey, {
      v: TOUR_STATE_VERSION,
      index,
      currentId: index >= 0 ? list[index]?.id || null : null,
      started,
      done,
      outcome,
    });
  }

  // Iterative by design: even thousands of stale selectors cannot overflow
  // the call stack, unlike a next()->next() missing-target implementation.
  function findAvailable(from, direction) {
    let cursor = Math.trunc(from);
    let checked = 0;
    while (cursor >= 0 && cursor < list.length && checked < list.length) {
      const target = resolveTourTarget(list[cursor], rootNow());
      if (target) return { index: cursor, target };
      cursor += direction;
      checked += 1;
    }
    return null;
  }

  function activate(found, reason) {
    if (!found) return finish("completed", reason === "restart" ? "restart-empty" : "complete");
    index = found.index;
    currentTarget = found.target;
    active = true;
    started = true;
    done = false;
    outcome = null;
    persist();
    return emit(reason);
  }

  function finish(nextOutcome = "completed", reason = "complete") {
    active = false;
    started = true;
    done = true;
    outcome = nextOutcome;
    currentTarget = null;
    if (list.length) index = Math.max(0, Math.min(index, list.length - 1));
    else index = -1;
    persist();
    return emit(reason);
  }

  const controller = {
    start({ restart = false } = {}) {
      if (restart) return controller.restart();
      if (done) return emit("already-complete");
      const from = index >= 0 ? index : 0;
      return activate(findAvailable(from, 1), "start");
    },

    resume() {
      return controller.start();
    },

    restart() {
      index = list.length ? 0 : -1;
      active = false;
      started = false;
      done = false;
      outcome = null;
      currentTarget = null;
      persist();
      return activate(findAvailable(0, 1), "restart");
    },

    next() {
      if (!active) return snapshot("inactive");
      const found = findAvailable(index + 1, 1);
      return found ? activate(found, "next") : finish("completed", "complete");
    },

    previous() {
      if (!active) return snapshot("inactive");
      const found = findAvailable(index - 1, -1);
      return found ? activate(found, "previous") : emit("first");
    },

    /**
     * Re-resolve after a render. If the current element vanished, advance to
     * the next available step instead of leaving an overlay pointed nowhere.
     */
    refresh() {
      if (!active) return snapshot("inactive");
      const found = findAvailable(index, 1);
      return found ? activate(found, found.index === index ? "refresh" : "target-missing") : finish("completed", "complete");
    },

    pause() {
      active = false;
      currentTarget = null;
      persist();
      return emit("pause");
    },

    skip() {
      return finish("skipped", "skip");
    },

    complete() {
      return finish("completed", "complete");
    },

    reset() {
      index = list.length ? 0 : -1;
      active = false;
      started = false;
      done = false;
      outcome = null;
      currentTarget = null;
      persist();
      return emit("reset");
    },

    getState() {
      return snapshot();
    },

    subscribe(listener, { immediate = false } = {}) {
      if (typeof listener !== "function") return () => {};
      listeners.add(listener);
      if (immediate) listener(snapshot());
      return () => listeners.delete(listener);
    },

    destroy() {
      listeners.clear();
      active = false;
      currentTarget = null;
    },
  };

  return Object.freeze(controller);
}

function restoreIndex(steps, saved) {
  if (!steps.length) return -1;
  const byId = saved.currentId
    ? steps.findIndex((step) => step.id === saved.currentId)
    : -1;
  if (byId >= 0) return byId;
  const numeric = Number(saved.index);
  return Number.isInteger(numeric)
    ? Math.max(0, Math.min(numeric, steps.length - 1))
    : 0;
}

function readTourState(storage, key) {
  try {
    const value = JSON.parse(storage?.getItem?.(key) || "null");
    return value && value.v === TOUR_STATE_VERSION ? value : {};
  } catch {
    return {};
  }
}

function writeTourState(storage, key, value) {
  try {
    storage?.setItem?.(key, JSON.stringify(value));
    return true;
  } catch {
    // Private-mode and quota failures should never break Studio controls.
    return false;
  }
}

function defaultRoot() {
  try {
    return globalThis.document || null;
  } catch {
    return null;
  }
}

function defaultStorage() {
  try {
    return globalThis.localStorage || null;
  } catch {
    return null;
  }
}
