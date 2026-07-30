import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const JSON_ASSETS = [
  "firebase.json",
  "manifest.webmanifest",
  "twa-manifest.json",
];

for (const path of JSON_ASSETS) {
  test(`${path} is strict UTF-8 JSON without a BOM`, async () => {
    const bytes = await readFile(new URL(`../${path}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    assert.doesNotThrow(() => JSON.parse(bytes.toString("utf8")));
  });
}
