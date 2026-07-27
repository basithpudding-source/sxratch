import test from "node:test";
import assert from "node:assert/strict";
import { buildGroove, GROOVES, GROOVE_FOR_TYPE } from "../js/pad-grooves.js";

const METERS = [
  { bars: 4, beatsPerBar: 4, subdiv: 4 },
  { bars: 4, beatsPerBar: 4, subdiv: 2 },
  { bars: 2, beatsPerBar: 3, subdiv: 4 },
  { bars: 4, beatsPerBar: 6, subdiv: 2 },
  { bars: 1, beatsPerBar: 4, subdiv: 3 },
  { bars: 8, beatsPerBar: 5, subdiv: 4 },
];

const ROWS = ["kick", "snare", "hat", "open", "crash", "tomH", "tomM", "tomL"];

test("every groove fills every row to the exact step count, in every meter", () => {
  for (const g of GROOVES) {
    for (const m of METERS) {
      const d = buildGroove(g, m);
      const want = m.bars * m.beatsPerBar * m.subdiv;
      for (const r of ROWS) {
        assert.ok(Array.isArray(d[r]), `${g}/${r} missing`);
        assert.equal(d[r].length, want, `${g}/${r} length in ${JSON.stringify(m)}`);
        // Values must stay on the sequencer's 0..3 scale, or drumVal(v)=v|0
        // silently turns them into something else.
        for (const v of d[r]) assert.ok(Number.isInteger(v) && v >= 0 && v <= 3, `${g}/${r} bad value ${v}`);
      }
    }
  }
});

test("every groove is audible and lands on the downbeat", () => {
  for (const g of GROOVES) {
    for (const m of METERS) {
      const d = buildGroove(g, m);
      const hits = ROWS.reduce((n, r) => n + d[r].filter(Boolean).length, 0);
      assert.ok(hits >= m.bars * 2, `${g} only ${hits} hits in ${JSON.stringify(m)}`);
      const onOne = ROWS.some((r) => d[r][0]);
      assert.ok(onOne, `${g} has nothing on beat 1 in ${JSON.stringify(m)}`);
    }
  }
});

test("the grooves are actually different from one another", () => {
  const m = METERS[0];
  const sigs = GROOVES.map((g) => JSON.stringify(buildGroove(g, m)));
  assert.equal(new Set(sigs).size, GROOVES.length, "two grooves are identical");
});

test("grooves are deterministic", () => {
  for (const g of GROOVES) {
    assert.deepEqual(buildGroove(g, METERS[0]), buildGroove(g, METERS[0]));
  }
});

test("density orders the way an arrangement does", () => {
  const m = { bars: 4, beatsPerBar: 4, subdiv: 4 };
  const density = (g) => ROWS.reduce((n, r) => n + buildGroove(g, m)[r].filter(Boolean).length, 0);
  assert.ok(density("sparse") < density("backbeat"), "sparse must be lighter than backbeat");
  assert.ok(density("backbeat") < density("build"), "build must be busier than backbeat");
  assert.ok(density("halftime") < density("four"), "the chorus must be busier than the bridge");
});

test("every section type maps to a real groove", () => {
  for (const [type, g] of Object.entries(GROOVE_FOR_TYPE)) {
    assert.ok(GROOVES.includes(g), `${type} maps to unknown groove ${g}`);
  }
});
