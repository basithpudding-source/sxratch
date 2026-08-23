// Portable PAD Studio project bundles.
//
// A PAD song normally keeps decoded audio clips in IndexedDB so the editable
// song document stays small.  This module creates a self-contained export for
// sharing/backup: a versioned JSON envelope with manifest checksums and binary
// assets encoded as base64.  The format deliberately avoids a ZIP dependency
// so it works in a plain browser module and remains inspectable/recoverable.

export const PROJECT_BUNDLE_FORMAT = "sxratch-pad-project";
export const PROJECT_BUNDLE_VERSION = 1;
export const PROJECT_BUNDLE_MIME = "application/vnd.sxratch.pad-project+json";
export const PROJECT_BUNDLE_EXTENSION = ".sxpad";
export const BUNDLE_AUDIO_MIME = "audio/x-sxratch-f32le";

export const DEFAULT_BUNDLE_LIMITS = Object.freeze({
  maxAssetBytes: 128 * 1024 * 1024,
  maxTotalAssetBytes: 256 * 1024 * 1024,
  maxBundleBytes: 384 * 1024 * 1024,
  maxAssets: 512,
});

export class ProjectBundleError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = "ProjectBundleError";
    this.code = code;
    if (details != null) this.details = details;
  }
}

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const HEX = "0123456789abcdef";

function fail(code, message, details = null) {
  throw new ProjectBundleError(code, message, details);
}

function asFiniteInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    fail("invalid", `${label} must be a whole number between ${min} and ${max}.`);
  }
  return n;
}

function normaliseLimits(input = {}) {
  const limits = { ...DEFAULT_BUNDLE_LIMITS, ...(input || {}) };
  for (const key of Object.keys(DEFAULT_BUNDLE_LIMITS)) {
    limits[key] = asFiniteInteger(limits[key], `Bundle limit ${key}`, { min: 1 });
  }
  if (limits.maxAssetBytes > limits.maxTotalAssetBytes) {
    fail("invalid", "Bundle limit maxAssetBytes cannot exceed maxTotalAssetBytes.");
  }
  if (limits.maxTotalAssetBytes > limits.maxBundleBytes) {
    fail("invalid", "Bundle limit maxTotalAssetBytes cannot exceed maxBundleBytes.");
  }
  return limits;
}

function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * JSON with recursively sorted keys.  It makes the manifest hash independent
 * of incidental object-key ordering and rejects values a browser cannot
 * faithfully restore from a portable project.
 */
function canonicalJson(value, label = "Value") {
  const ancestors = new Set();
  const visit = (current, path) => {
    if (current === null) return "null";
    switch (typeof current) {
      case "string":
      case "boolean": return JSON.stringify(current);
      case "number":
        if (!Number.isFinite(current)) fail("invalid", `${label} contains a non-finite number at ${path}.`);
        return JSON.stringify(current);
      case "object": break;
      default:
        fail("invalid", `${label} contains an unsupported ${typeof current} value at ${path}.`);
    }
    if (ancestors.has(current)) fail("invalid", `${label} contains a circular reference at ${path}.`);
    ancestors.add(current);
    let output;
    if (Array.isArray(current)) {
      output = `[${current.map((item, index) => visit(item, `${path}[${index}]`)).join(",")}]`;
    } else if (isPlainObject(current)) {
      const keys = Object.keys(current).sort();
      output = `{${keys.map((key) => `${JSON.stringify(key)}:${visit(current[key], `${path}.${key}`)}`).join(",")}}`;
    } else {
      fail("invalid", `${label} contains a non-JSON object at ${path}.`);
    }
    ancestors.delete(current);
    return output;
  };
  return visit(value, "$" );
}

function cloneJson(value, label) {
  return JSON.parse(canonicalJson(value, label));
}

function byteLengthOfText(text) {
  return encoder.encode(text).byteLength;
}

function quoteAsset(asset) {
  return `“${asset?.name || asset?.id || "unnamed asset"}”`;
}

function normaliseId(value, label = "Asset id") {
  const id = typeof value === "string" ? value.trim() : "";
  if (!id) fail("invalid", `${label} is required.`);
  if (id.length > 256) fail("invalid", `${label} is too long.`);
  if (/[\u0000-\u001f]/.test(id)) fail("invalid", `${label} contains control characters.`);
  return id;
}

function normaliseName(value, fallback) {
  const name = String(value ?? fallback).trim();
  if (!name) fail("invalid", "Asset name is required.");
  if (name.length > 512) fail("invalid", `Asset name ${quoteAsset({ name })} is too long.`);
  return name;
}

function normaliseType(value) {
  const type = String(value || "application/octet-stream").trim().toLowerCase();
  if (!type || type.length > 160 || /[\u0000-\u001f]/.test(type)) {
    fail("invalid", "Asset type must be a short MIME-like string.");
  }
  return type;
}

function copyBytes(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  return null;
}

async function bytesFrom(value, label) {
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return new Uint8Array(await value.arrayBuffer());
  }
  if (typeof value === "string") return encoder.encode(value);
  const bytes = copyBytes(value);
  if (bytes) return bytes;
  fail("invalid", `${label} must be a Blob, ArrayBuffer, typed array, or text string.`);
}

function isAudioBufferLike(value) {
  return !!value
    && typeof value.getChannelData === "function"
    && Number.isInteger(value.numberOfChannels)
    && Number.isInteger(value.length)
    && Number.isFinite(value.sampleRate);
}

function normaliseAudioMetadata(value, byteLength, label) {
  if (!isPlainObject(value)) fail("invalid", `${label} has invalid audio metadata.`);
  const format = String(value.format || "").toLowerCase();
  if (format !== "f32le-interleaved") {
    fail("invalid", `${label} uses unsupported audio encoding “${value.format || "unknown"}”.`);
  }
  const sampleRate = Number(value.sampleRate);
  const channels = Number(value.channels);
  const frames = Number(value.frames);
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000) {
    fail("invalid", `${label} has an invalid sample rate.`);
  }
  if (!Number.isInteger(channels) || channels < 1 || channels > 32) {
    fail("invalid", `${label} has an invalid channel count.`);
  }
  if (!Number.isInteger(frames) || frames < 0) {
    fail("invalid", `${label} has an invalid frame count.`);
  }
  const expected = frames * channels * 4;
  if (!Number.isSafeInteger(expected) || expected !== byteLength) {
    fail("invalid", `${label} audio data is incomplete or has an invalid length.`);
  }
  return { format, sampleRate, channels, frames };
}

function audioBytesFromBuffer(buffer, label = "Audio buffer") {
  if (!isAudioBufferLike(buffer)) fail("invalid", `${label} is not an AudioBuffer.`);
  const channels = asFiniteInteger(buffer.numberOfChannels, `${label} channel count`, { min: 1, max: 32 });
  const frames = asFiniteInteger(buffer.length, `${label} frame count`, { min: 0 });
  const sampleRate = Number(buffer.sampleRate);
  if (!Number.isFinite(sampleRate) || sampleRate < 8_000 || sampleRate > 384_000) {
    fail("invalid", `${label} has an invalid sample rate.`);
  }
  const byteLength = frames * channels * 4;
  if (!Number.isSafeInteger(byteLength)) fail("too-large", `${label} is too large to bundle safely.`);
  const output = new Uint8Array(byteLength);
  const view = new DataView(output.buffer);
  const sources = [];
  for (let channel = 0; channel < channels; channel++) {
    let source;
    try { source = buffer.getChannelData(channel); } catch {
      fail("invalid", `${label} channel ${channel + 1} could not be read.`);
    }
    if (!source || source.length < frames) fail("invalid", `${label} channel ${channel + 1} is incomplete.`);
    sources.push(source);
  }
  let offset = 0;
  for (let frame = 0; frame < frames; frame++) {
    for (let channel = 0; channel < channels; channel++) {
      view.setFloat32(offset, sources[channel][frame] || 0, true);
      offset += 4;
    }
  }
  return {
    bytes: output,
    audio: { format: "f32le-interleaved", sampleRate, channels, frames },
  };
}

/** Convert an AudioBuffer to a lossless audio asset accepted by createProjectBundle. */
export function audioBufferToBundleAsset({ id, name, buffer, type = BUNDLE_AUDIO_MIME } = {}) {
  const assetId = normaliseId(id);
  const encoded = audioBytesFromBuffer(buffer, `Audio asset ${quoteAsset({ id: assetId, name })}`);
  return {
    id: assetId,
    name: normaliseName(name, assetId),
    type: normaliseType(type),
    data: encoded.bytes.buffer,
    audio: encoded.audio,
  };
}

/** Restore a parsed lossless audio asset into an AudioContext-compatible buffer. */
export function bundleAssetToAudioBuffer(asset, audioContext) {
  if (!audioContext || typeof audioContext.createBuffer !== "function") {
    fail("invalid", "An AudioContext is required to restore project audio.");
  }
  if (!asset || !asset.audio) fail("invalid", "This project asset is not lossless PAD audio.");
  const bytes = copyBytes(asset.data);
  if (!bytes) fail("invalid", "This project audio asset has no binary data.");
  const audio = normaliseAudioMetadata(asset.audio, bytes.byteLength, `Audio asset ${quoteAsset(asset)}`);
  let buffer;
  try {
    buffer = audioContext.createBuffer(audio.channels, audio.frames, audio.sampleRate);
  } catch {
    fail("invalid", `Audio asset ${quoteAsset(asset)} could not be allocated in this browser.`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const channels = [];
  for (let channel = 0; channel < audio.channels; channel++) {
    const target = buffer.getChannelData(channel);
    if (!target || target.length < audio.frames) {
      fail("invalid", `Audio asset ${quoteAsset(asset)} could not be restored in this browser.`);
    }
    channels.push(target);
  }
  let offset = 0;
  for (let frame = 0; frame < audio.frames; frame++) {
    for (let channel = 0; channel < audio.channels; channel++) {
      channels[channel][frame] = view.getFloat32(offset, true);
      offset += 4;
    }
  }
  return buffer;
}

function base64Encode(bytes) {
  // btoa accepts a binary string. Chunking avoids blowing the argument stack
  // on ordinary multi-minute audio clips.
  const parts = [];
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    let binary = "";
    const end = Math.min(offset + chunk, bytes.length);
    for (let i = offset; i < end; i++) binary += String.fromCharCode(bytes[i]);
    parts.push(binary);
  }
  try {
    return btoa(parts.join(""));
  } catch {
    fail("encoding", "This browser could not encode project audio for export.");
  }
}

function base64Decode(value, label) {
  if (typeof value !== "string" || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    fail("invalid", `${label} has invalid base64 data.`);
  }
  let binary;
  try { binary = atob(value); } catch {
    fail("invalid", `${label} has invalid base64 data.`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function sha256(bytes) {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle || typeof subtle.digest !== "function") {
    fail("crypto-unavailable", "This browser cannot verify portable project integrity because Web Crypto is unavailable.");
  }
  let digest;
  try {
    digest = new Uint8Array(await subtle.digest("SHA-256", bytes));
  } catch {
    fail("crypto-unavailable", "This browser could not verify portable project integrity.");
  }
  let output = "";
  for (const byte of digest) output += HEX[byte >>> 4] + HEX[byte & 15];
  return output;
}

function assetDescriptors(assets) {
  if (assets == null) return [];
  if (assets instanceof Map) return [...assets.entries()].map(([id, data]) => ({ id, data }));
  if (Array.isArray(assets)) return assets;
  if (typeof assets?.[Symbol.iterator] === "function") return [...assets];
  if (isPlainObject(assets)) return Object.entries(assets).map(([id, data]) => ({ id, data }));
  fail("invalid", "Project assets must be an array, Map, iterable, or id-to-data object.");
}

async function normaliseAssets(assets, limits) {
  const descriptors = assetDescriptors(assets);
  if (descriptors.length > limits.maxAssets) {
    fail("too-large", `This project has ${descriptors.length} assets; the export limit is ${limits.maxAssets}.`);
  }
  const usedIds = new Set();
  let total = 0;
  const output = [];
  for (const descriptor of descriptors) {
    if (!isPlainObject(descriptor)) fail("invalid", "Each project asset must include an id and data.");
    const id = normaliseId(descriptor.id);
    if (usedIds.has(id)) fail("invalid", `Project bundle contains duplicate asset id “${id}”.`);
    usedIds.add(id);
    const name = normaliseName(descriptor.name, id);
    const label = `Asset ${quoteAsset({ id, name })}`;
    const type = normaliseType(descriptor.type);
    const source = descriptor.data ?? descriptor.blob ?? descriptor.buffer;
    if (source == null) fail("invalid", `${label} has no binary data.`);
    let bytes;
    let audio = descriptor.audio;
    if (isAudioBufferLike(source)) {
      const encoded = audioBytesFromBuffer(source, label);
      bytes = encoded.bytes;
      audio = encoded.audio;
    } else {
      bytes = await bytesFrom(source, label);
      if (audio != null) audio = normaliseAudioMetadata(audio, bytes.byteLength, label);
    }
    if (bytes.byteLength > limits.maxAssetBytes) {
      fail("too-large", `${label} is ${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB; the export limit is ${(limits.maxAssetBytes / 1024 / 1024).toFixed(0)} MB per asset.`);
    }
    total += bytes.byteLength;
    if (total > limits.maxTotalAssetBytes) {
      fail("too-large", `Project audio is ${(total / 1024 / 1024).toFixed(1)} MB; the export limit is ${(limits.maxTotalAssetBytes / 1024 / 1024).toFixed(0)} MB.`);
    }
    output.push({
      id,
      name,
      type,
      bytes: bytes.byteLength,
      sha256: await sha256(bytes),
      encoding: "base64",
      ...(audio ? { audio } : {}),
      data: base64Encode(bytes),
    });
  }
  return { assets: output, totalBytes: total };
}

/** Return audio clip ids referenced by the current PAD song model. */
export function referencedProjectAssetIds(song) {
  const ids = new Set();
  for (const track of Array.isArray(song?.tracks) ? song.tracks : []) {
    for (const region of Array.isArray(track?.regions) ? track.regions : []) {
      if (typeof region?.clipId === "string" && region.clipId) ids.add(region.clipId);
    }
  }
  return [...ids].sort();
}

function missingReferencedAssetIds(song, assets) {
  const supplied = new Set(assets.map((asset) => asset.id));
  return referencedProjectAssetIds(song).filter((id) => !supplied.has(id));
}

function ensureReferencedAssets(song, assets) {
  const missing = missingReferencedAssetIds(song, assets);
  if (missing.length) {
    const label = missing.length === 1 ? "audio clip" : "audio clips";
    fail("missing-assets", `This project cannot be made portable because ${missing.length} ${label} ${missing.length === 1 ? "is" : "are"} unavailable: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? "…" : ""}. Re-import the source audio, then export again.`, { missing });
  }
}

function canonicalSha(value, label) {
  const json = canonicalJson(value, label);
  return { json, bytes: encoder.encode(json) };
}

/**
 * Create a self-contained versioned project file.  Assets can be Blobs,
 * ArrayBuffers, typed arrays, strings, or AudioBuffers.  AudioBuffers are
 * stored losslessly as f32 interleaved data and can later be restored with
 * bundleAssetToAudioBuffer.
 */
export async function createProjectBundle({
  song,
  assets = [],
  metadata = {},
  createdAt = new Date().toISOString(),
  requireReferencedAssets = true,
  limits,
} = {}) {
  if (!isPlainObject(song)) fail("invalid", "A PAD song object is required to export a project bundle.");
  const resolvedLimits = normaliseLimits(limits);
  const songHash = canonicalSha(song, "Song");
  const metadataCopy = cloneJson(metadata, "Project metadata");
  const { assets: bundleAssets, totalBytes } = await normaliseAssets(assets, resolvedLimits);
  const songCopy = JSON.parse(songHash.json);
  if (requireReferencedAssets) ensureReferencedAssets(songCopy, bundleAssets);
  const payload = {
    format: PROJECT_BUNDLE_FORMAT,
    version: PROJECT_BUNDLE_VERSION,
    createdAt: String(createdAt || new Date().toISOString()),
    manifest: {
      songBytes: songHash.bytes.byteLength,
      songSha256: await sha256(songHash.bytes),
      assetCount: bundleAssets.length,
      totalAssetBytes: totalBytes,
    },
    song: songCopy,
    assets: bundleAssets,
    metadata: metadataCopy,
  };
  const text = JSON.stringify(payload);
  const bundleBytes = byteLengthOfText(text);
  if (bundleBytes > resolvedLimits.maxBundleBytes) {
    fail("too-large", `The portable project is ${(bundleBytes / 1024 / 1024).toFixed(1)} MB after packaging; the export limit is ${(resolvedLimits.maxBundleBytes / 1024 / 1024).toFixed(0)} MB.`);
  }
  return new Blob([text], { type: PROJECT_BUNDLE_MIME });
}

async function inputBytes(input, limits) {
  if (typeof input === "string") {
    const bytes = encoder.encode(input);
    if (bytes.byteLength > limits.maxBundleBytes) {
      fail("too-large", "This project file is larger than the safe import limit.");
    }
    return bytes;
  }
  if (typeof Blob !== "undefined" && input instanceof Blob) {
    if (input.size > limits.maxBundleBytes) fail("too-large", "This project file is larger than the safe import limit.");
    return new Uint8Array(await input.arrayBuffer());
  }
  const bytes = copyBytes(input);
  if (!bytes) fail("invalid", "Choose a portable PAD project file to import.");
  if (bytes.byteLength > limits.maxBundleBytes) fail("too-large", "This project file is larger than the safe import limit.");
  return bytes;
}

function parseJson(bytes) {
  let text;
  try { text = decoder.decode(bytes); } catch {
    fail("invalid", "This project file is not valid UTF-8 text.");
  }
  try { return JSON.parse(text); } catch {
    fail("invalid", "This project file is not valid JSON.");
  }
}

function validChecksum(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/i.test(value);
}

async function parseAsset(record, limits, usedIds) {
  if (!isPlainObject(record)) fail("invalid", "This project contains an invalid asset entry.");
  const id = normaliseId(record.id);
  if (usedIds.has(id)) fail("invalid", `This project contains duplicate asset id “${id}”.`);
  usedIds.add(id);
  const name = normaliseName(record.name, id);
  const label = `Asset ${quoteAsset({ id, name })}`;
  const type = normaliseType(record.type);
  if (record.encoding !== "base64") fail("invalid", `${label} uses an unsupported asset encoding.`);
  const expectedBytes = asFiniteInteger(record.bytes, `${label} byte count`, { min: 0, max: limits.maxAssetBytes });
  if (!validChecksum(record.sha256)) fail("invalid", `${label} has no valid integrity checksum.`);
  const bytes = base64Decode(record.data, label);
  if (bytes.byteLength !== expectedBytes) fail("integrity", `${label} is damaged or incomplete.`);
  const checksum = await sha256(bytes);
  if (checksum !== record.sha256.toLowerCase()) fail("integrity", `${label} failed its integrity check. Export it again from the original browser.`);
  const audio = record.audio == null ? null : normaliseAudioMetadata(record.audio, bytes.byteLength, label);
  return {
    id,
    name,
    type,
    data: bytes.buffer,
    bytes: bytes.byteLength,
    sha256: checksum,
    ...(audio ? { audio } : {}),
  };
}

/**
 * Verify and read a portable PAD project.  The returned song and metadata are
 * JSON-safe clones, and each asset has an owned ArrayBuffer.  By default a
 * bundle with audio regions missing their matching assets is rejected rather
 * than silently opening a broken project.
 */
export async function parseProjectBundle(input, {
  limits,
  requireReferencedAssets = true,
} = {}) {
  const resolvedLimits = normaliseLimits(limits);
  const bytes = await inputBytes(input, resolvedLimits);
  const payload = parseJson(bytes);
  if (!isPlainObject(payload) || payload.format !== PROJECT_BUNDLE_FORMAT) {
    fail("format", "This is not a Sxratch PAD portable project file.");
  }
  const version = Number(payload.version);
  if (!Number.isInteger(version) || version < 1) fail("format", "This project file has an invalid format version.");
  if (version > PROJECT_BUNDLE_VERSION) {
    fail("unsupported-version", `This project uses format v${version}. Update Sxratch before opening it.`);
  }
  if (version !== PROJECT_BUNDLE_VERSION) fail("unsupported-version", `This project uses unsupported format v${version}.`);
  if (!isPlainObject(payload.manifest)) fail("invalid", "This project has no valid integrity manifest.");
  if (!Array.isArray(payload.assets)) fail("invalid", "This project has no valid asset list.");
  if (payload.assets.length > resolvedLimits.maxAssets) {
    fail("too-large", `This project has ${payload.assets.length} assets; the import limit is ${resolvedLimits.maxAssets}.`);
  }
  const songHash = canonicalSha(payload.song, "Song");
  const expectedSongBytes = asFiniteInteger(payload.manifest.songBytes, "Song byte count", { min: 2, max: resolvedLimits.maxBundleBytes });
  if (!validChecksum(payload.manifest.songSha256)) fail("invalid", "This project has no valid song integrity checksum.");
  if (songHash.bytes.byteLength !== expectedSongBytes || await sha256(songHash.bytes) !== payload.manifest.songSha256.toLowerCase()) {
    fail("integrity", "This project song data failed its integrity check.");
  }
  const assets = [];
  const usedIds = new Set();
  let totalBytes = 0;
  for (const record of payload.assets) {
    const asset = await parseAsset(record, resolvedLimits, usedIds);
    totalBytes += asset.bytes;
    if (totalBytes > resolvedLimits.maxTotalAssetBytes) {
      fail("too-large", "This project contains more audio data than the safe import limit.");
    }
    assets.push(asset);
  }
  const expectedAssetCount = asFiniteInteger(payload.manifest.assetCount, "Asset count", { min: 0, max: resolvedLimits.maxAssets });
  const expectedTotal = asFiniteInteger(payload.manifest.totalAssetBytes, "Total asset byte count", { min: 0, max: resolvedLimits.maxTotalAssetBytes });
  if (expectedAssetCount !== assets.length || expectedTotal !== totalBytes) {
    fail("integrity", "This project asset manifest does not match its contents.");
  }
  const song = JSON.parse(songHash.json);
  const missingAssetIds = missingReferencedAssetIds(song, assets);
  if (requireReferencedAssets && missingAssetIds.length) {
    ensureReferencedAssets(song, assets);
  }
  return {
    format: PROJECT_BUNDLE_FORMAT,
    version,
    createdAt: typeof payload.createdAt === "string" ? payload.createdAt : null,
    song,
    assets,
    metadata: cloneJson(payload.metadata ?? {}, "Project metadata"),
    missingAssetIds,
    totalAssetBytes: totalBytes,
  };
}
