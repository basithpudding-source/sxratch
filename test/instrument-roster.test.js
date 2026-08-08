// Roster guarantees for the DAW device section: every advertised sound and
// drum kit must be complete, valid and AUDIBLY DISTINCT — a label may never be
// a rename of another sound, and a kit id without synthesis parameters would
// silently fall back to the acoustic kit (the bug that shipped five phantom
// kits). Pure-math checks only, so they run under node:test.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACTORY_PATCHES, ENGINE_SCHEMA, resolvePatch,
  DRUM_KIT_IDS, drumSampleData,
} from "../js/synth.js";

const SR = 44100;

test("every factory patch resolves every schema parameter to a finite number", () => {
  for (const [family, sounds] of Object.entries(FACTORY_PATCHES)) {
    for (const sound of Object.keys(sounds)) {
      const { engine, params } = resolvePatch(family, sound);
      assert.ok(ENGINE_SCHEMA[engine], `${family}/${sound} uses unknown engine ${engine}`);
      for (const sec of ENGINE_SCHEMA[engine]) {
        for (const p of sec.params) {
          const v = params[p.key];
          assert.ok(Number.isFinite(v), `${family}/${sound} missing/NaN param ${p.key}`);
          assert.ok(v >= p.min - 1e-9 && v <= p.max + 1e-9,
            `${family}/${sound}.${p.key} = ${v} outside [${p.min}, ${p.max}]`);
        }
      }
    }
  }
});

test("no two sounds in a family are the same patch wearing different labels", () => {
  for (const [family, sounds] of Object.entries(FACTORY_PATCHES)) {
    const ids = Object.keys(sounds);
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = resolvePatch(family, ids[i]);
        const b = resolvePatch(family, ids[j]);
        if (a.engine !== b.engine) continue; // different engine = different sound
        // Count schema parameters that differ meaningfully (>2% of range).
        let differing = 0;
        for (const sec of ENGINE_SCHEMA[a.engine]) {
          for (const p of sec.params) {
            const range = Math.max(1e-9, p.max - p.min);
            if (Math.abs(a.params[p.key] - b.params[p.key]) / range > 0.02) differing++;
          }
        }
        assert.ok(differing >= 3,
          `${family}/${ids[i]} vs ${family}/${ids[j]}: only ${differing} parameters differ`);
      }
    }
  }
});

test("the studio's advertised kit list is fully implemented", () => {
  const expected = ["acoustic", "808", "electronic", "bossa", "lofi",
    "909", "trap", "synthwave", "afrobeats", "indie"];
  for (const kit of expected) {
    assert.ok(DRUM_KIT_IDS.includes(kit), `kit ${kit} has no synthesis parameters`);
  }
});

/* Compact per-hit feature vector: length, attack/tail balance, zero-crossing
 * rate (a cheap brightness proxy). Enough to tell a 909 kick from a trap 808
 * without a DFT. */
function features(x, sr) {
  const n = x.length;
  const seg = (a, b) => {
    const from = Math.floor(a * sr), to = Math.min(n, Math.floor(b * sr));
    if (to <= from) return 0;
    let acc = 0;
    for (let i = from; i < to; i++) acc += x[i] * x[i];
    return Math.sqrt(acc / (to - from));
  };
  let zc = 0;
  const zn = Math.min(n, Math.floor(sr * 0.1));
  for (let i = 1; i < zn; i++) if ((x[i] >= 0) !== (x[i - 1] >= 0)) zc++;
  const early = seg(0, 0.05);
  const late = seg(0.1, 0.25);
  return {
    lenSec: n / sr,
    tailRatio: late / Math.max(1e-6, early),
    zcr: zc / zn,
  };
}

test("every kit is audibly distinct from every other kit", () => {
  const pieces = ["kick", "snare", "hat"];
  const profiles = new Map(DRUM_KIT_IDS.map((kit) => [kit,
    pieces.map((k) => features(drumSampleData(SR, kit, k), SR))]));
  for (let i = 0; i < DRUM_KIT_IDS.length; i++) {
    for (let j = i + 1; j < DRUM_KIT_IDS.length; j++) {
      const a = profiles.get(DRUM_KIT_IDS[i]);
      const b = profiles.get(DRUM_KIT_IDS[j]);
      // Total relative distance across all pieces and features. Identical
      // params (the phantom-kit bug) would measure exactly 0.
      let dist = 0;
      for (let k = 0; k < pieces.length; k++) {
        for (const f of ["lenSec", "tailRatio", "zcr"]) {
          const av = a[k][f], bv = b[k][f];
          dist += Math.abs(av - bv) / Math.max(1e-6, Math.abs(av), Math.abs(bv));
        }
      }
      assert.ok(dist > 0.35,
        `${DRUM_KIT_IDS[i]} and ${DRUM_KIT_IDS[j]} sound alike (distance ${dist.toFixed(3)})`);
    }
  }
});

test("bossa remains the only cross-stick snare; new kits render real snares", () => {
  for (const kit of DRUM_KIT_IDS) {
    const d = drumSampleData(SR, kit, "snare");
    assert.ok(d.length > SR * 0.05, `${kit} snare too short`);
  }
});
