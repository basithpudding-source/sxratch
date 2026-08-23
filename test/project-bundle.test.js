import test from "node:test";
import assert from "node:assert/strict";

import {
  BUNDLE_AUDIO_MIME,
  PROJECT_BUNDLE_FORMAT,
  ProjectBundleError,
  audioBufferToBundleAsset,
  bundleAssetToAudioBuffer,
  createProjectBundle,
  parseProjectBundle,
  referencedProjectAssetIds,
} from "../js/project-bundle.js";

const song = () => ({
  v: 4,
  bpm: 120,
  tracks: [{ id: "audio-1", kind: "audio", regions: [{ id: "region-1", clipId: "clip-1", start: 0, len: 4 }] }],
});

function fakeAudioBuffer(channels, sampleRate = 48_000) {
  const data = channels.map((channel) => new Float32Array(channel));
  return {
    numberOfChannels: data.length,
    length: data[0].length,
    sampleRate,
    getChannelData(index) { return data[index]; },
  };
}

test("portable bundle round-trips song, arbitrary binary assets, and metadata", async () => {
  const source = song();
  const file = await createProjectBundle({
    song: source,
    assets: [{ id: "clip-1", name: "Vocal take", type: "audio/wav", data: new Uint8Array([1, 2, 3, 4]) }],
    metadata: { title: "Late-night sketch", author: "Mina" },
  });
  assert.equal(file.type, "application/vnd.sxratch.pad-project+json");
  const restored = await parseProjectBundle(file);
  assert.equal(restored.format, PROJECT_BUNDLE_FORMAT);
  assert.deepEqual(restored.song, source);
  assert.deepEqual(restored.metadata, { author: "Mina", title: "Late-night sketch" });
  assert.equal(restored.assets[0].name, "Vocal take");
  assert.deepEqual([...new Uint8Array(restored.assets[0].data)], [1, 2, 3, 4]);
  assert.deepEqual(restored.missingAssetIds, []);
});

test("bundle rejects missing audio referenced by the arrangement", async () => {
  await assert.rejects(
    () => createProjectBundle({ song: song(), assets: [] }),
    (error) => error instanceof ProjectBundleError && error.code === "missing-assets",
  );
});

test("bundle detects asset tampering before import", async () => {
  const file = await createProjectBundle({
    song: song(),
    assets: [{ id: "clip-1", data: new Uint8Array([10, 20, 30]) }],
  });
  const tampered = JSON.parse(await file.text());
  tampered.assets[0].data = "AAAA";
  await assert.rejects(
    () => parseProjectBundle(JSON.stringify(tampered)),
    (error) => error instanceof ProjectBundleError && error.code === "integrity",
  );
});

test("lossless AudioBuffer project assets restore sample values and metadata", async () => {
  const original = fakeAudioBuffer([[0.25, -0.5], [1, 0]], 44_100);
  const asset = audioBufferToBundleAsset({ id: "clip-1", name: "Stereo take", buffer: original });
  assert.equal(asset.type, BUNDLE_AUDIO_MIME);
  const file = await createProjectBundle({ song: song(), assets: [asset] });
  const restored = await parseProjectBundle(file);
  const allocated = [];
  const context = {
    createBuffer(channels, frames, sampleRate) {
      const buffer = fakeAudioBuffer(Array.from({ length: channels }, () => new Float32Array(frames)), sampleRate);
      allocated.push(buffer);
      return buffer;
    },
  };
  const audio = bundleAssetToAudioBuffer(restored.assets[0], context);
  assert.equal(audio, allocated[0]);
  assert.equal(audio.sampleRate, 44_100);
  assert.deepEqual([...audio.getChannelData(0)], [0.25, -0.5]);
  assert.deepEqual([...audio.getChannelData(1)], [1, 0]);
});

test("referencedProjectAssetIds only exposes audio clip dependencies", () => {
  assert.deepEqual(referencedProjectAssetIds({
    tracks: [
      { regions: [{ clipId: "b" }, { clipId: "a" }] },
      { regions: [{ clipId: "b" }, {}] },
    ],
  }), ["a", "b"]);
});
