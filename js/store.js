// Versioned localStorage envelopes — a migration path for persisted state.
//
// Before this, sxratch.song / sxratch.projects / sxratch.config were bare
// JSON: any breaking shape change would silently load stale data (or throw,
// get caught, and be treated as "no data" — discarding the user's work).
// Values are now wrapped as { __sxv: <version>, data } and legacy raw values
// are treated as version 0 and run through the migration chain.

const hasEnvelope = (x) => !!x && typeof x === "object" && Number.isInteger(x.__sxv) && "data" in x;

/**
 * Read a versioned value together with optional envelope metadata.
 *
 * Metadata is deliberately outside `data`: persistence callers can attach
 * freshness/failure information without leaking storage bookkeeping into the
 * document model. Legacy and older envelopes simply return `metadata: null`.
 */
export function readVersionedRecord(key, version, migrations = []) {
  let raw;
  try { raw = localStorage.getItem(key); } catch { return null; }
  if (raw == null) return null;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  let v = 0, data = parsed, metadata = null;
  if (hasEnvelope(parsed)) {
    v = parsed.__sxv;
    data = parsed.data;
    metadata = parsed.__sxmeta && typeof parsed.__sxmeta === "object"
      ? parsed.__sxmeta
      : null;
  }
  if (v > version) return { data, metadata }; // written by a newer app version — best effort
  for (; v < version; v++) {
    const mig = migrations[v];
    if (mig) {
      try { data = mig(data); } catch (e) { console.warn(`migration v${v} failed for ${key}`, e); return null; }
    }
  }
  return { data, metadata };
}

/**
 * Read a versioned value. Legacy (unwrapped) values are version 0.
 * `migrations[i]` upgrades data from version i to i+1; a missing entry is an
 * identity step. Returns null when absent or unrecoverable.
 */
export function readVersioned(key, version, migrations = []) {
  return readVersionedRecord(key, version, migrations)?.data ?? null;
}

/**
 * Write a versioned value. Returns false on failure (quota, private mode) —
 * and calls `onQuota` so callers can TELL the user instead of losing edits
 * silently.
 */
export function writeVersioned(key, version, data, { onQuota, metadata = null } = {}) {
  try {
    const envelope = { __sxv: version, data };
    if (metadata && typeof metadata === "object") envelope.__sxmeta = metadata;
    localStorage.setItem(key, JSON.stringify(envelope));
    return true;
  } catch (e) {
    onQuota?.(e);
    return false;
  }
}
