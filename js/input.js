// Sxratch input handling: scratch pads, rotary knobs, and keyboard.

const MAX_RATE = 14; // clamp insane flick velocities

// Pointer capture can throw for non-active pointer ids (and in some test
// environments); never let that break a gesture handler.
const capture = (el, id) => { try { el.setPointerCapture(id); } catch {} };
const release = (el, id) => { try { el.releasePointerCapture(id); } catch {} };

/**
 * Turn an element into a turntable scratch surface.
 * Horizontal drag = scratch (left/right moves the audio back/forth), matching
 * the "trackpad split down the middle" model. Works with mouse and touch via
 * Pointer Events.
 *
 * @param {HTMLElement} el
 * @param {import("./audio-engine.js").Deck} deck
 * @param {object} opts { sensitivity (seconds of audio per pixel), onScratch }
 */
export function attachScratchPad(el, deck, opts = {}) {
  const sensitivity = opts.sensitivity ?? 0.0024; // s of audio per pixel
  let active = false;
  let lastX = 0;
  let lastT = 0;
  let pointerId = null;

  const down = (e) => {
    active = true;
    pointerId = e.pointerId;
    lastX = e.clientX;
    lastT = e.timeStamp;
    capture(el, pointerId);
    el.classList.add("touching");
    deck.touchStart();
    if (opts.onScratchStart) opts.onScratchStart();
    e.preventDefault();
  };

  const move = (e) => {
    if (!active || e.pointerId !== pointerId) return;
    // Process the high-frequency samples the browser coalesced into this event
    // (touchscreens report 120-240Hz between 60Hz frames) so fast flicks get
    // accurate, fine-grained velocity instead of one averaged delta per frame.
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    const samples = coalesced && coalesced.length ? coalesced : [e];
    for (const ev of samples) {
      const dx = ev.clientX - lastX;
      let dt = (ev.timeStamp - lastT) / 1000;
      if (dt <= 0) dt = 1 / 240;
      lastX = ev.clientX;
      lastT = ev.timeStamp;

      // rate (in normal-speed units) = pixels/sec * seconds-of-audio/pixel
      let rate = (dx / dt) * sensitivity;
      if (rate > MAX_RATE) rate = MAX_RATE;
      else if (rate < -MAX_RATE) rate = -MAX_RATE;
      deck.jog(rate);
      if (opts.onScratch) opts.onScratch(rate);
    }
    e.preventDefault();
  };

  const up = (e) => {
    if (!active || e.pointerId !== pointerId) return;
    active = false;
    release(el, pointerId);
    el.classList.remove("touching");
    deck.touchEnd();
    if (opts.onScratchEnd) opts.onScratchEnd();
    e.preventDefault();
  };

  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  el.addEventListener("lostpointercapture", up);
  // Stop the page from panning/zooming when scratching on mobile.
  el.style.touchAction = "none";
}

/**
 * Rotary knob: vertical drag changes value. Also supports wheel.
 * @param {HTMLElement} el
 * @param {object} opts { value (0..1), onChange, indicator (el to rotate) }
 */
export function attachKnob(el, opts = {}) {
  let value = opts.value ?? 0.5;
  const def = opts.default ?? 0.5;
  const range = opts.range ?? 270; // degrees of travel
  let active = false;
  let startY = 0;
  let startVal = 0;
  let pointerId = null;

  const render = () => {
    const angle = (value - 0.5) * range;
    const ind = opts.indicator || el;
    ind.style.transform = `rotate(${angle}deg)`;
    el.setAttribute("aria-valuenow", value.toFixed(2));
  };

  const set = (v) => {
    value = Math.max(0, Math.min(1, v));
    render();
    opts.onChange?.(value);
  };

  el.addEventListener("pointerdown", (e) => {
    active = true;
    pointerId = e.pointerId;
    startY = e.clientY;
    startVal = value;
    capture(el, pointerId);
    e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!active || e.pointerId !== pointerId) return;
    const dy = startY - e.clientY;       // up = increase
    set(startVal + dy / 180);            // 180px = full sweep
    e.preventDefault();
  });
  const end = (e) => {
    if (!active) return;
    active = false;
    release(el, pointerId);
  };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("dblclick", () => set(def)); // reset to neutral
  el.addEventListener("wheel", (e) => {
    set(value - Math.sign(e.deltaY) * 0.04);
    e.preventDefault();
  }, { passive: false });
  el.style.touchAction = "none";

  render();
  return { set, get: () => value };
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/** Move the crossfader and keep engine + UI in sync (single source of truth). */
function nudgeCrossfade(engine, ui, value) {
  const v = clamp(value, 0, 1);
  engine.setCrossfade(v);
  ui.syncCrossfade(v);
}

/**
 * Custom slider with a tick scale, a large grab handle, and double-click reset.
 * Builds its own DOM inside `el` (an empty `.fader` container with `.v` or `.h`).
 *
 * @param {HTMLElement} el
 * @param {object} opts { min, max, value, default, orientation, step,
 *                        ticks:[{at,label,major}], onChange }
 * @returns {{ set:(v:number, fire?:boolean)=>void, get:()=>number, el:HTMLElement }}
 */
export function attachFader(el, opts = {}) {
  const min = opts.min ?? 0;
  const max = opts.max ?? 1;
  const vertical = (opts.orientation || (el.classList.contains("h") ? "h" : "v")) === "v";
  const def = opts.default ?? (min + max) / 2;
  let value = opts.value ?? def;

  el.classList.add("fader", vertical ? "v" : "h");
  el.innerHTML = "";
  const track = document.createElement("div"); track.className = "fader-track";
  const ticks = document.createElement("div"); ticks.className = "fader-ticks";
  const fill = document.createElement("div"); fill.className = "fader-fill";
  const handle = document.createElement("div"); handle.className = "fader-handle";
  track.append(ticks, fill, handle);
  el.append(track);

  const pct = (v) => (v - min) / (max - min); // 0..1
  const edge = vertical ? "bottom" : "left";

  for (const t of opts.ticks || []) {
    const p = pct(t.at) * 100;
    const tick = document.createElement("div");
    tick.className = "tick" + (t.major ? " major" : "");
    tick.style[edge] = p + "%";
    ticks.append(tick);
    if (t.label != null) {
      const lab = document.createElement("span");
      lab.className = "tick-label";
      lab.textContent = t.label;
      lab.style[edge] = p + "%";
      ticks.append(lab);
    }
  }

  const render = () => {
    const p = pct(value) * 100;
    handle.style[edge] = p + "%";
    if (vertical) fill.style.height = p + "%";
    else fill.style.width = p + "%";
    el.setAttribute("aria-valuenow", value.toFixed(3));
  };

  const set = (v, fire = true) => {
    v = clamp(v, min, max);
    if (opts.step) v = Math.round(v / opts.step) * opts.step;
    value = v;
    render();
    if (fire) opts.onChange?.(value);
  };

  let active = false, pointerId = null;
  const valueFromEvent = (e) => {
    const r = track.getBoundingClientRect();
    const frac = vertical ? 1 - (e.clientY - r.top) / r.height : (e.clientX - r.left) / r.width;
    return min + clamp(frac, 0, 1) * (max - min);
  };
  el.addEventListener("pointerdown", (e) => {
    active = true; pointerId = e.pointerId; capture(el, pointerId);
    set(valueFromEvent(e)); e.preventDefault();
  });
  el.addEventListener("pointermove", (e) => {
    if (!active || e.pointerId !== pointerId) return;
    set(valueFromEvent(e)); e.preventDefault();
  });
  const end = () => { if (active) { active = false; release(el, pointerId); } };
  el.addEventListener("pointerup", end);
  el.addEventListener("pointercancel", end);
  el.addEventListener("dblclick", (e) => { set(def); e.preventDefault(); });
  el.style.touchAction = "none";

  render();
  return { set, get: () => value, el };
}

/**
 * Desktop trackpad gestures — no clicking required, fully remappable.
 *
 * A two-finger trackpad swipe arrives as `wheel` events while a one-finger move
 * is just `mousemove`. The browser never reveals where the fingers physically
 * sit on the trackpad, so the deck is selected by a held key (default: a Ctrl):
 *
 *   - Hold `gestures.armA` (default right Ctrl) -> scratch Deck A.
 *   - Hold `gestures.armB` (default left  Ctrl) -> scratch Deck B.
 *   - Add the matching slam modifier (`slamAMod` / `slamBMod`) to also throw the
 *     crossfader fully to that deck; releasing restores the previous position.
 *   - Two-finger HORIZONTAL (no modifier) -> move the crossfader.
 *
 * All bindings / sensitivities are read live from `config.gestures`, so the
 * settings panel can change them on the fly.
 *
 * @param {import("./audio-engine.js").AudioEngine} engine
 * @param {import("./ui.js").UI} ui
 * @param {{gestures:object}} config
 */
export function attachTrackpadGestures(engine, ui, config) {
  const pads = { A: document.getElementById("pad-A"), B: document.getElementById("pad-B") };
  const g = () => config.gestures;

  const held = new Set();  // every currently-held key code
  let lastArm = null;      // most recent of the two arm keys (for recency)
  let armedDeck = null, slamTarget = null, slamSaved = null;
  let lastMoveT = 0;

  const normDelta = (e) => {
    const f = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 100 : 1;
    return { dx: e.deltaX * f, dy: e.deltaY * f };
  };

  // "Grab" / release the platter (hand on the record) as a deck arms / disarms.
  const setGrab = (deck, on) => {
    if (!deck) return;
    if (on) { engine.decks[deck].touchStart(); pads[deck]?.classList.add("touching"); }
    else { engine.decks[deck].touchEnd(); pads[deck]?.classList.remove("touching"); }
  };

  const refreshArmed = () => {
    const gg = g();
    const aH = held.has(gg.armA), bH = held.has(gg.armB);
    const next = aH && bH ? (lastArm === gg.armB ? "B" : "A") : aH ? "A" : bH ? "B" : null;
    if (next === armedDeck) return;
    setGrab(armedDeck, false);   // let go of the previous deck
    armedDeck = next;
    pads.A.classList.toggle("armed", armedDeck === "A");
    pads.B.classList.toggle("armed", armedDeck === "B");
    if (armedDeck) { setGrab(armedDeck, true); lastMoveT = 0; }
  };

  const refreshSlam = () => {
    const gg = g();
    let target = null;
    if (held.has(gg.armA) && held.has(gg.slamAMod)) target = 0;
    else if (held.has(gg.armB) && held.has(gg.slamBMod)) target = 1;
    if (target === slamTarget) return;
    if (slamTarget === null && target !== null) slamSaved = engine.crossfade; // entering slam
    slamTarget = target;
    if (target !== null) nudgeCrossfade(engine, ui, target);
    else if (slamSaved !== null) { nudgeCrossfade(engine, ui, slamSaved); slamSaved = null; }
  };

  window.addEventListener("keydown", (e) => {
    if (held.has(e.code)) return; // ignore auto-repeat
    held.add(e.code);
    const gg = g();
    if (e.code === gg.armA || e.code === gg.armB) lastArm = e.code;
    refreshArmed();
    refreshSlam();
  });
  window.addEventListener("keyup", (e) => {
    if (!held.has(e.code)) return;
    held.delete(e.code);
    refreshArmed();
    refreshSlam();
  });
  window.addEventListener("blur", () => { held.clear(); refreshArmed(); refreshSlam(); });

  // ONE-FINGER SCRATCH: while a deck is armed (a modifier is held), moving the
  // cursor up/down (a single finger on the trackpad) scratches that deck,
  // proportional to the movement. No click, no second finger.
  window.addEventListener("mousemove", (e) => {
    if (!armedDeck) return;
    const gg = g();
    const now = performance.now();
    let dt = lastMoveT ? (now - lastMoveT) / 1000 : 1 / 120;
    if (dt <= 0 || dt > 0.2) dt = 1 / 120;
    lastMoveT = now;
    const dy = e.movementY || 0; // relative vertical movement in px
    const dir = gg.invertScratch ? 1 : -1; // up = forward by default
    const rate = clamp((dir * dy / dt) * gg.scratchSensitivity, -16, 16);
    engine.decks[armedDeck].jog(rate);
  });

  // Two-finger HORIZONTAL swipe -> crossfader (one finger is reserved for
  // scratching). Vertical wheel is ignored / pinch-zoom is swallowed.
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.target.closest && e.target.closest("input, .knob, .dialog, .waveform, .fader")) return;
      const gg = g();
      const { dx, dy } = normDelta(e);
      if (Math.abs(dx) < Math.abs(dy)) { // vertical-dominant: not a crossfade
        if (e.ctrlKey) e.preventDefault(); // stop ctrl/pinch zoom
        return;
      }
      nudgeCrossfade(engine, ui, engine.crossfade + dx * gg.crossfadeSensitivity);
      e.preventDefault();
    },
    { passive: false }
  );
}

/**
 * Make a waveform interactive: grab-to-scrub (audible), click-to-seek (needle
 * drop), Shift-click to set a hot cue, click a cue to snap to it, double-click a
 * cue to clear it.
 *
 * @param {HTMLCanvasElement} canvas
 * @param {import("./audio-engine.js").Deck} deck
 * @param {import("./waveform.js").Waveform} wave
 * @param {object} cb { onSeek(pos), onSetCue(pos), onClearCue(slotIndex) }
 */
export function attachWaveformScrub(canvas, deck, wave, cb = {}) {
  let active = false, moved = false, pointerId = null, lastX = 0, lastT = 0, downX = 0;

  canvas.addEventListener("pointerdown", (e) => {
    active = true; moved = false; pointerId = e.pointerId;
    lastX = downX = e.clientX; lastT = e.timeStamp;
    capture(canvas, pointerId);
    canvas.classList.add("grabbing");
    deck.touchStart();
    e.preventDefault();
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!active || e.pointerId !== pointerId) return;
    if (Math.abs(e.clientX - downX) > 3) moved = true;
    const secPerPx = wave.secondsPerPixel() || 0.002;
    // Use coalesced samples for 1:1, high-resolution scrubbing.
    const coalesced = e.getCoalescedEvents ? e.getCoalescedEvents() : null;
    const samples = coalesced && coalesced.length ? coalesced : [e];
    for (const ev of samples) {
      const dx = ev.clientX - lastX;
      let dt = (ev.timeStamp - lastT) / 1000;
      if (dt <= 0) dt = 1 / 240;
      lastX = ev.clientX; lastT = ev.timeStamp;
      // Grab the "tape": dragging right rewinds, dragging left fast-forwards,
      // 1:1 with the pixels on screen so it feels physical.
      const rate = clamp((-dx / dt) * secPerPx, -16, 16);
      deck.jog(rate);
    }
    e.preventDefault();
  });

  const up = (e) => {
    if (!active || e.pointerId !== pointerId) return;
    active = false;
    release(canvas, pointerId);
    canvas.classList.remove("grabbing");
    deck.touchEnd();
    if (!moved) {
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (e.shiftKey) {
        cb.onSetCue?.(wave.positionAtX(x));
      } else {
        const ci = wave.cueAt(x);
        cb.onSeek?.(ci >= 0 ? wave.cues[ci].pos : wave.positionAtX(x));
      }
    }
    e.preventDefault();
  };
  canvas.addEventListener("pointerup", up);
  canvas.addEventListener("pointercancel", up);

  canvas.addEventListener("dblclick", (e) => {
    const rect = canvas.getBoundingClientRect();
    const ci = wave.cueAt(e.clientX - rect.left);
    if (ci >= 0 && wave.cues[ci].label != null) cb.onClearCue?.(wave.cues[ci].label - 1);
  });
}
