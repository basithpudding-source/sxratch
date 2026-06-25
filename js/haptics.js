// Haptic feedback via the Vibration API (Android Chrome; silently no-ops where
// unsupported, e.g. desktop and iOS Safari). Kept tiny and never throwing so it
// can be sprinkled on any interaction.

let enabled = true;

export function setHapticsEnabled(on) { enabled = !!on; }

export function hapticsSupported() {
  return typeof navigator !== "undefined" && typeof navigator.vibrate === "function";
}

/** Fire a short vibration. `pattern` is ms or an on/off array (Vibration API). */
export function haptic(pattern = 10) {
  if (!enabled || !hapticsSupported()) return;
  try { navigator.vibrate(pattern); } catch {}
}
