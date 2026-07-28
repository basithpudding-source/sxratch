// PAD grid geometry — pure functions, no DOM.
//
// The step grid's layout used to be described TWICE: once in CSS
// (`--lblw: 54px`, `--cell: 18px`, `gap: 3px`) and once in JS constants
// (`LABEL_W 52, GAP 3, CELL_W 20`) used to place the playhead. They
// disagreed, so the playhead drifted ~2px per step — about 126px by step 63
// on desktop, and further on the mobile override. The cure is to stop
// computing pixels in JS at all: the renderer writes a COLUMN INDEX into a
// custom property and CSS does the arithmetic with its own values, which
// makes the two descriptions the same description.
//
// What is left here is the sizing maths — how many steps fit, how wide a
// cell can be, how tall a row can be — which is genuine logic and is unit
// tested in test/pad-geometry.test.js.

/**
 * Choose how much of a section to show at once.
 *
 * Cells must stay big enough to hit: below `minCell` a grid is a row of
 * pinpricks, which is what a whole 4-bar 16th-note section at 1280px wide
 * degenerates into (14.8px). So we page instead of shrinking — pick the
 * largest bar count whose cell width still clears the floor.
 *
 * @param {object} o
 * @param {number} o.availW    px available to the grid (content box)
 * @param {number} o.lblw      row-label column width, px
 * @param {number} o.gap       grid gap, px
 * @param {number} o.stepsPerBar
 * @param {number} o.bars      bars in the section
 * @param {number} o.minCell   smallest acceptable cell, px (raise on touch)
 * @param {number} [o.maxBars] never show more than this many bars at once
 * @returns {{pageSteps:number, cellW:number, pages:number, bars:number}}
 */
export function fitPage({ availW, lblw, gap, stepsPerBar, bars, minCell, maxBars = 4 }) {
  const total = Math.max(1, Math.round(stepsPerBar * bars));
  const widthFor = (n) => (availW - lblw - gap * (n + 1)) / n;

  // Whole-bar pages first, largest to smallest, then a half-bar fallback for
  // very narrow viewports. A page never exceeds the section itself.
  const candidates = [];
  for (let b = Math.min(maxBars, bars); b >= 1; b--) candidates.push(Math.round(stepsPerBar * b));
  candidates.push(Math.max(1, Math.round(stepsPerBar / 2)));

  for (const n of candidates) {
    const steps = Math.min(total, n);
    const w = widthFor(steps);
    if (w >= minCell) {
      return {
        pageSteps: steps,
        cellW: Math.floor(w),
        pages: Math.ceil(total / steps),
        bars: steps / stepsPerBar,
      };
    }
  }

  // Nothing clears the floor (a very small window). Show the smallest page we
  // were willing to consider at the floor size and let it scroll — never
  // return a sub-floor cell, because that is the failure we are avoiding.
  const steps = Math.min(total, Math.max(1, Math.round(stepsPerBar / 2)));
  return { pageSteps: steps, cellW: minCell, pages: Math.ceil(total / steps), bars: steps / stepsPerBar };
}

/**
 * Where the playhead is, as a COLUMN INDEX within the visible page.
 * `onPage` is false when playback has moved past the page the user is
 * looking at — the caller decides whether to follow or to leave them be.
 *
 * @returns {{step:number, col:number, onPage:boolean}}
 */
export function playCol(elapsed, stepSec, page0, pageSteps) {
  const step = elapsed / stepSec;
  const col = step - page0;
  return { step, col, onPage: col >= 0 && col <= pageSteps };
}

/**
 * Resolve a panel-edge drag into a size and an open/closed state.
 *
 * One rule serves all three panels (section rail, inspector, keyboard dock):
 * the size tracks the pointer inside [min, max], and dragging past
 * `collapseBelow` snaps the panel shut rather than pinning it at a useless
 * sliver — a 40px inspector is worse than no inspector. The stored size is
 * preserved on collapse so reopening restores what the user had.
 *
 * `delta` is signed toward "bigger" — the caller flips the axis (a right
 * panel grows as the pointer moves left).
 */
export function resolvePanelDrag({ startSize, delta, min, max, collapseBelow }) {
  const raw = startSize + delta;
  if (raw < collapseBelow) return { size: Math.max(min, Math.min(max, startSize)), open: false };
  return { size: Math.max(min, Math.min(max, raw)), open: true };
}

/**
 * Split the available height between a lane's rows.
 * Returns the row height, and how many rows actually fit when even the
 * minimum will not (so the caller can window rather than squash).
 */
export function fitRows({ availH, rows, gap, minRow }) {
  const n = Math.max(1, rows);
  const h = (availH - gap * (n - 1)) / n;
  if (h >= minRow) return { rowH: Math.floor(h), window: n };
  const fit = Math.max(1, Math.floor((availH + gap) / (minRow + gap)));
  return { rowH: minRow, window: Math.min(n, fit) };
}
