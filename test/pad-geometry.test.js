import test from "node:test";
import assert from "node:assert/strict";
import { fitPage, playCol, fitRows, resolvePanelDrag } from "../js/pad-geometry.js";

// The widths the real layout hands the grid at each target viewport.
// centre column = viewport - shell padding - rail - inspector - gaps.
const CASES = [
  { name: "1280x800", availW: 676, minCell: 28 },
  { name: "1440x900", availW: 836, minCell: 28 },
  { name: "1366x768", availW: 611, minCell: 28 },
  { name: "1024 landscape", availW: 864, minCell: 28 },
  { name: "844x390 phone", availW: 671, minCell: 40 },
];

test("fitPage never returns a cell below the hit-size floor", () => {
  for (const c of CASES) {
    for (const bars of [1, 2, 4, 8, 16]) {
      for (const stepsPerBar of [8, 12, 16]) {
        const r = fitPage({ availW: c.availW, lblw: 74, gap: 4, stepsPerBar, bars, minCell: c.minCell });
        assert.ok(r.cellW >= c.minCell, `${c.name} ${bars}b/${stepsPerBar}spb gave ${r.cellW}px`);
        assert.ok(r.pageSteps >= 1);
        assert.ok(r.pages >= 1);
      }
    }
  }
});

test("fitPage shows the whole section when it comfortably fits", () => {
  // 1 bar of 8ths at 1440 — 8 steps in 836px is roomy, so one page.
  const r = fitPage({ availW: 836, lblw: 74, gap: 4, stepsPerBar: 8, bars: 1, minCell: 28 });
  assert.equal(r.pageSteps, 8);
  assert.equal(r.pages, 1);
});

test("fitPage pages a dense section instead of shrinking it", () => {
  // 4 bars of 16ths = 64 steps; at 676px that would be 6px cells.
  const r = fitPage({ availW: 676, lblw: 74, gap: 4, stepsPerBar: 16, bars: 4, minCell: 28 });
  assert.ok(r.pageSteps < 64, "must not try to show all 64 steps");
  assert.equal(r.pages * r.pageSteps >= 64, true);
  assert.ok(r.cellW >= 28);
});

test("fitPage cell width matches the CSS box maths it feeds", () => {
  const availW = 676, lblw = 74, gap = 4;
  const r = fitPage({ availW, lblw, gap, stepsPerBar: 16, bars: 4, minCell: 28 });
  const used = lblw + gap * (r.pageSteps + 1) + r.cellW * r.pageSteps;
  assert.ok(used <= availW, `layout overflows: ${used} > ${availW}`);
  assert.ok(availW - used < r.pageSteps + 1, "more than a rounding remainder is wasted");
});

test("playCol is exactly linear in the step pitch", () => {
  const stepSec = 0.125;
  for (let step = 0; step <= 16; step++) {
    const { col } = playCol(step * stepSec, stepSec, 0, 16);
    assert.ok(Math.abs(col - step) < 1e-9, `step ${step} -> col ${col}`);
  }
});

test("playCol reports when playback has left the visible page", () => {
  const stepSec = 0.1;
  assert.equal(playCol(0.5, stepSec, 0, 16).onPage, true);
  assert.equal(playCol(2.5, stepSec, 0, 16).onPage, false);   // step 25, page 0..16
  assert.equal(playCol(2.5, stepSec, 16, 16).onPage, true);   // page 16..32
  assert.equal(playCol(0.5, stepSec, 16, 16).onPage, false);  // before the page
});

test("fitRows splits evenly, and windows rather than squashing", () => {
  const even = fitRows({ availH: 335, rows: 8, gap: 4, minRow: 20 });
  assert.equal(even.window, 8);
  assert.ok(even.rowH >= 20);
  assert.ok(even.rowH * 8 + 4 * 7 <= 335);

  const tight = fitRows({ availH: 141, rows: 8, gap: 4, minRow: 32 });
  assert.equal(tight.rowH, 32);
  assert.ok(tight.window < 8, "must window when 8 rows cannot fit at the floor");
  assert.ok(tight.window * 32 + 4 * (tight.window - 1) <= 141);
});

test("resolvePanelDrag: tracks the pointer inside [min, max]", () => {
  const opts = { startSize: 236, min: 150, max: 340, collapseBelow: 90 };
  assert.deepEqual(resolvePanelDrag({ ...opts, delta: 40 }), { size: 276, open: true });
  assert.deepEqual(resolvePanelDrag({ ...opts, delta: 300 }), { size: 340, open: true });
  assert.deepEqual(resolvePanelDrag({ ...opts, delta: -60 }), { size: 176, open: true });
});

test("resolvePanelDrag: collapses past the floor instead of pinning a sliver", () => {
  const opts = { startSize: 236, min: 150, max: 340, collapseBelow: 90 };
  const r = resolvePanelDrag({ ...opts, delta: -200 });
  assert.equal(r.open, false);
  // The stored size survives the collapse, so reopening restores it.
  assert.equal(r.size, 236);
});

test("resolvePanelDrag: a size already outside the range is brought back in", () => {
  // e.g. a width persisted on a wide monitor, reopened on a narrow one.
  const r = resolvePanelDrag({ startSize: 500, delta: 0, min: 150, max: 340, collapseBelow: 90 });
  assert.deepEqual(r, { size: 340, open: true });
});
