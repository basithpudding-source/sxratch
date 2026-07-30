// IndexedDB persistence for PAD sampler slices.
//
// Sampler-row PLACEMENTS always persisted with the song, but the audio
// buffers lived only in memory — every reload turned rows into ⚠ "re-import"
// stubs. Buffers are stored as raw Float32Array channel data (structured clone
// handles typed arrays natively). Sampler assets use a budget-capped LRU;
// DAW project clips are pinned and rely on the browser quota instead, because
// silently evicting audio that a saved arrangement references is data loss.
//
// All methods resolve gracefully (null / false) when IndexedDB is
// unavailable (private mode) — persistence is an enhancement, never a
// requirement.

const DB_NAME = "sxratch";
const STORE = "pad-samples";
export const SAMPLE_BUDGET_BYTES = 50 * 1024 * 1024; // sampler/non-project audio only

function openDb() {
  return new Promise((resolve) => {
    let req;
    try { req = indexedDB.open(DB_NAME, 1); } catch { resolve(null); return; }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

const tx = (db, mode, fn) => new Promise((resolve) => {
  try {
    const t = db.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(out?.result ?? true);
    t.onerror = () => resolve(null);
    t.onabort = () => resolve(null);
  } catch { resolve(null); }
});

const recBytes = (rec) => rec.channels.reduce((a, c) => a + c.byteLength, 0);

/**
 * Save one sample. `buffer` is an AudioBuffer; stored as
 * { id, name, sampleRate, channels: Float32Array[], savedAt, bytes, pinned }.
 * Pinned records are project data and are never removed by sampler LRU.
 */
export async function saveSample(id, name, buffer, { pinned = false } = {}) {
  const db = await openDb();
  if (!db) return false;
  const channels = [];
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    channels.push(new Float32Array(buffer.getChannelData(c))); // copy — source is live
  }
  const rec = { id, name, sampleRate: buffer.sampleRate, channels, savedAt: Date.now(), bytes: 0, pinned: !!pinned };
  rec.bytes = recBytes(rec);
  const ok = await tx(db, "readwrite", (store) => store.put(rec));
  if (ok) await enforceBudget(db);
  db.close();
  return !!ok;
}

/** Load every stored sample as { id, name, sampleRate, channels, pinned }. */
export async function loadAllSamples() {
  const db = await openDb();
  if (!db) return [];
  const all = await new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
  db.close();
  return all;
}

export async function deleteSample(id) {
  const db = await openDb();
  if (!db) return false;
  const ok = await tx(db, "readwrite", (store) => store.delete(id));
  db.close();
  return !!ok;
}

export function samplesToEvict(records, budgetBytes = SAMPLE_BUDGET_BYTES) {
  const evictable = (records || []).filter((r) => !r.pinned);
  let total = evictable.reduce((a, r) => a + (r.bytes || recBytes(r)), 0);
  if (total <= budgetBytes) return [];
  evictable.sort((a, b) => (a.savedAt || 0) - (b.savedAt || 0));
  const ids = [];
  for (const r of evictable) {
    if (total <= budgetBytes) break;
    ids.push(r.id);
    total -= r.bytes || recBytes(r);
  }
  return ids;
}

/** Evict oldest non-project samples until their own cache fits the budget. */
async function enforceBudget(db) {
  const all = await new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
  for (const id of samplesToEvict(all)) {
    await tx(db, "readwrite", (store) => store.delete(id));
  }
}
