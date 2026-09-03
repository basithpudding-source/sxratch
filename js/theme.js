// Theme control — dark / light / auto.
//
// The CSS side is css/tokens.css: dark values in the base block, light ones
// in an explicit override block. This module owns the four things CSS cannot
// do on its own:
//   1. persisting an explicit choice (auto | light | dark),
//   2. handing resolved COLOURS to the canvas painters (2D contexts take
//      strings, not custom properties), including the waveform Web Worker
//      which has no DOM at all,
//   3. keeping <meta name="theme-color"> honest for the PWA chrome,
//   4. mirroring the choice onto <body> so Chrome re-resolves the
//      view-scoped tokens on a runtime toggle (see applyTheme).
//
// Why a probe element: `getComputedStyle(el).getPropertyValue('--x')`
// returns the raw declaration text for a custom property, not a colour.
// Assigning it to a real property (`color`) forces resolution, and the
// computed `color` comes back as an rgb()/rgba() string a canvas accepts.

const STORE_KEY = "sxratch.config";
export const THEME_MODES = ["auto", "light", "dark"];

/** Tokens the canvas painters need, resolved on every theme change. */
const CANVAS_TOKENS = [
  "--sx-wave-body",
  "--sx-wave-grid-beat",
  "--sx-wave-grid-bar",
  "--sx-wave-label",
  "--sx-wave-centre",
  "--sx-wave-playhead",
  "--sx-wave-cue-ink",
  "--sx-deck-a",
  "--sx-deck-b",
  "--sx-viz-a",
  "--sx-viz-b",
  "--sx-accent",
  "--sx-text-3",
  "--sx-line",
  "--sx-patch-hi",
  "--sx-patch-lo",
  "--sx-cue-1",
  "--sx-cue-2",
  "--sx-cue-3",
  "--sx-cue-4",
  "--sx-cue-5",
  "--sx-cue-6",
  "--sx-cue-7",
  "--sx-cue-8",
];

let _mode = "auto";
let _colors = null;
const listeners = new Set();

let _probe = null;
function probe() {
  if (_probe && _probe.isConnected) return _probe;
  _probe = document.createElement("span");
  // Not `display:none` — a display:none element still computes `color`,
  // but keeping it in flow-but-invisible avoids UA quirks around
  // subtree-invalidation on some engines.
  _probe.style.cssText = "position:absolute;width:0;height:0;opacity:0;pointer-events:none";
  _probe.setAttribute("aria-hidden", "true");
  document.body.appendChild(_probe);
  return _probe;
}

/** Resolve one custom property to a concrete colour string. */
export function resolveToken(name, fallback = "#000") {
  try {
    const p = probe();
    p.style.color = "";
    p.style.color = `var(${name})`;
    const c = getComputedStyle(p).color;
    return c && c !== "" ? c : fallback;
  } catch {
    return fallback;
  }
}

/** The effective theme right now — "light" or "dark", never "auto". */
export function effectiveTheme() {
  if (_mode !== "auto") return _mode;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

/** Cached map of resolved canvas colours. Rebuilt on every theme change. */
export function themeColors() {
  if (!_colors) {
    _colors = {};
    for (const t of CANVAS_TOKENS) _colors[t.replace(/^--sx-/, "")] = resolveToken(t);
    _colors.cues = [1, 2, 3, 4, 5, 6, 7, 8].map((i) => _colors["cue-" + i]);
  }
  return _colors;
}

/** Subscribe to theme changes. Returns an unsubscribe function. */
export function onThemeChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function syncMetaThemeColor() {
  const bg = resolveToken("--sx-bg", "#0a0f1c");
  let meta = document.querySelector('meta[name="theme-color"]:not([media])');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  meta.setAttribute("content", bg);
}

/**
 * Apply a theme mode. The attribute always carries the RESOLVED theme
 * ("light"/"dark", never "auto" and never absent): tokens.css has exactly
 * one light block, keyed off [data-theme="light"]. "Auto" is resolved here
 * against the OS preference, and initTheme's matchMedia listener re-applies
 * on OS changes so auto still tracks the system live.
 */
export function applyTheme(mode) {
  _mode = THEME_MODES.includes(mode) ? mode : "auto";
  const resolved = effectiveTheme();
  const root = document.documentElement;
  root.dataset.theme = resolved;

  // The attribute is mirrored onto <body> as well, for any body-scoped token
  // overrides. Chrome did not re-resolve custom properties declared in a
  // body-scoped block when only an attribute on <html> changed — the :root
  // tokens updated and the body-scoped ones kept their old values, so a
  // runtime toggle left the studio showing dark text on a light surface
  // until the next reload. An element's own attribute always invalidates
  // its own style.
  if (document.body) {
    document.body.dataset.theme = resolved;
    // Flush the invalidation before anything reads a computed colour. When a
    // view switch (which toggles `view-studio` on the same element) lands in
    // the same style pass as the theme change, Chrome would otherwise serve
    // the previous pass's token values to the very next getComputedStyle.
    void document.body.offsetWidth;
  }
  _colors = null;
  // Deliberately a timeout, not requestAnimationFrame: rAF never fires in a
  // background/uncomposited tab, which would leave every canvas painted in
  // the old theme until the tab is looked at again. The one-task delay is
  // still needed — Safari resolves custom properties against the *previous*
  // color-scheme within the task that changed it.
  setTimeout(() => {
    _colors = null;
    syncMetaThemeColor();
    const colors = themeColors();
    const theme = effectiveTheme();
    listeners.forEach((fn) => {
      try { fn(colors, theme); } catch (e) { console.warn("theme listener failed", e); }
    });
    document.dispatchEvent(new CustomEvent("sxratch:themechange", { detail: { colors, theme } }));
  }, 0);
  return _mode;
}

export function themeMode() { return _mode; }

/** Cycle auto → light → dark → auto (the topbar button). */
export function cycleTheme() {
  const next = THEME_MODES[(THEME_MODES.indexOf(_mode) + 1) % THEME_MODES.length];
  return applyTheme(next);
}

/**
 * Boot. `initial` comes from the persisted config; the inline <head>
 * script has already set data-theme so there is no flash, and this call
 * only has to agree with it and start the OS-change listener.
 */
export function initTheme(initial = "auto") {
  applyTheme(initial);
  window.matchMedia?.("(prefers-color-scheme: light)").addEventListener?.("change", () => {
    if (_mode === "auto") applyTheme("auto");
  });
  return _mode;
}

/** Read the persisted mode without pulling in app.js's config machinery. */
export function storedTheme() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return "auto";
    const parsed = JSON.parse(raw);
    const data = parsed && typeof parsed === "object" && "data" in parsed ? parsed.data : parsed;
    const t = data && data.theme;
    return THEME_MODES.includes(t) ? t : "auto";
  } catch {
    return "auto";
  }
}
