// IndexedDB persistence for PAD sampler slices and DAW project documents.
//
// Sampler-row PLACEMENTS always persist with the song, while their decoded
// audio buffers are stored here as raw Float32Array channel data. Sampler
// assets use a budget-capped LRU; DAW project clips are pinned and rely on the
// browser quota because silently evicting referenced audio is data loss.
//
// DAW song documents use a separate pair of stores. Replacing the current
// document and preserving its previous revision happen in one transaction;
// writes/restores are also serialized in this module so a slow older write can
// never land after a newer one.

const DB_NAME = "sxratch";
const DB_VERSION = 2;
const SAMPLE_STORE = "pad-samples";
const DAW_SONG_STORE = "daw-songs";
const DAW_RECOVERY_STORE = "daw-recovery";
const RECOVERY_PROJECT_INDEX = "projectId";
const RECOVERY_TIME_INDEX = "projectSavedAt";
const MAX_DAW_RECOVERIES = 3;

export const SAMPLE_BUDGET_BYTES = 50 * 1024 * 1024; // sampler/non-project audio only

/**
 * Collect audio clip ids referenced by DAW song documents. Callers may pass
 * either bare song data or persisted current/recovery records with a `data`
 * property.
 */
export function collectDawClipIds(documents) {
  const ids = new Set();
  for (const document of documents || []) {
    const song = document?.data ?? document;
    for (const track of Array.isArray(song?.tracks) ? song.tracks : []) {
      for (const region of Array.isArray(track?.regions) ? track.regions : []) {
        if (typeof region?.clipId === "string" && region.clipId) ids.add(region.clipId);
      }
    }
  }
  return ids;
}

/** An actionable IndexedDB failure for DAW callers to surface in the UI. */
export class DawStorageError extends Error {
  constructor(code, message, cause = null) {
    super(message);
    this.name = "DawStorageError";
    this.code = code;
    if (cause != null) this.cause = cause;
  }
}

/**
 * Decide whether a localStorage snapshot written after an IndexedDB failure
 * must win over the IndexedDB current record on the next boot.
 *
 * `baseRevision` is the last IndexedDB revision observed by the writer. It is
 * the primary signal because wall clocks can move or share a millisecond. When
 * the failed writer could not read IndexedDB, `failedAt` provides a best-effort
 * fallback against the record timestamp.
 */
export function shouldPreferDawFallback(marker, idbRecord) {
  if (!marker || typeof marker !== "object") return false;
  const baseRevision = marker.baseRevision;
  const failedAt = Number(marker.failedAt);
  const hasBaseRevision = Number.isInteger(baseRevision) && baseRevision >= 0;
  const hasFailedAt = Number.isFinite(failedAt) && failedAt > 0;
  if (!hasBaseRevision && !hasFailedAt) return false;
  if (!idbRecord) return true;

  const idbRevision = idbRecord.revision;
  if (hasBaseRevision && Number.isInteger(idbRevision) && idbRevision >= 0) {
    return idbRevision <= baseRevision;
  }

  const idbSavedAt = Number(idbRecord.savedAt);
  return hasFailedAt
    && (!Number.isFinite(idbSavedAt) || idbSavedAt <= failedAt);
}

function storageError(error, fallbackCode, action) {
  if (error instanceof DawStorageError) return error;
  const name = error?.name || "";
  const code = name === "QuotaExceededError"
    ? "quota"
    : name === "DataCloneError"
      ? "clone"
      : name === "VersionError"
        ? "version"
        : name === "AbortError"
          ? "aborted"
          : fallbackCode;
  const detail = error?.message ? `: ${error.message}` : "";
  return new DawStorageError(code, `IndexedDB ${action} failed${detail}`, error);
}

function upgradeDb(db, transaction) {
  if (!db.objectStoreNames.contains(SAMPLE_STORE)) {
    db.createObjectStore(SAMPLE_STORE, { keyPath: "id" });
  }
  if (!db.objectStoreNames.contains(DAW_SONG_STORE)) {
    db.createObjectStore(DAW_SONG_STORE, { keyPath: "id" });
  }
  const recoveries = db.objectStoreNames.contains(DAW_RECOVERY_STORE)
    ? transaction.objectStore(DAW_RECOVERY_STORE)
    : db.createObjectStore(DAW_RECOVERY_STORE, { keyPath: "id" });
  if (!recoveries.indexNames.contains(RECOVERY_PROJECT_INDEX)) {
    recoveries.createIndex(RECOVERY_PROJECT_INDEX, "projectId", { unique: false });
  }
  if (!recoveries.indexNames.contains(RECOVERY_TIME_INDEX)) {
    recoveries.createIndex(
      RECOVERY_TIME_INDEX,
      ["projectId", "savedAt"],
      { unique: false },
    );
  }
}

/**
 * Open the shared database. Existing sampler callers deliberately retain their
 * graceful null/false behavior; DAW callers use strict mode and receive a
 * DawStorageError that the status UI can explain.
 */
function openDb({ strict = false } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      if (strict) reject(new DawStorageError("unavailable", "IndexedDB is unavailable in this browser context."));
      else resolve(null);
      return;
    }
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      if (strict) reject(storageError(error, "open", "open"));
      else resolve(null);
      return;
    }
    let settled = false;
    let upgradeError = null;
    const finish = (value, error = null) => {
      if (settled) {
        if (value && typeof value.close === "function") value.close();
        return;
      }
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    req.onupgradeneeded = () => {
      try {
        upgradeDb(req.result, req.transaction);
      } catch (error) {
        upgradeError = error;
        try { req.transaction?.abort(); } catch {}
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      // Another tab upgrading later must not remain blocked by this connection.
      db.onversionchange = () => db.close();
      if (upgradeError) finish(db, storageError(upgradeError, "upgrade", "upgrade"));
      else finish(db);
    };
    req.onerror = () => {
      const error = storageError(upgradeError || req.error, upgradeError ? "upgrade" : "open", upgradeError ? "upgrade" : "open");
      if (strict) finish(null, error);
      else finish(null);
    };
    req.onblocked = () => {
      const error = new DawStorageError(
        "blocked",
        "IndexedDB upgrade is blocked by another open Sxratch tab. Close the other tab and retry.",
      );
      if (strict) finish(null, error);
      else finish(null);
    };
  });
}

const sampleTx = (db, mode, fn) => new Promise((resolve) => {
  try {
    const t = db.transaction(SAMPLE_STORE, mode);
    const out = fn(t.objectStore(SAMPLE_STORE));
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
  const ok = await sampleTx(db, "readwrite", (store) => store.put(rec));
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
      const req = db.transaction(SAMPLE_STORE, "readonly").objectStore(SAMPLE_STORE).getAll();
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
  const ok = await sampleTx(db, "readwrite", (store) => store.delete(id));
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
      const req = db.transaction(SAMPLE_STORE, "readonly").objectStore(SAMPLE_STORE).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
  for (const id of samplesToEvict(all)) {
    await sampleTx(db, "readwrite", (store) => store.delete(id));
  }
}

/* -------------------------- DAW song documents -------------------------- */

let dawWriteTail = Promise.resolve();

function queueDawWrite(job) {
  const result = dawWriteTail.then(job, job);
  // Keep the queue usable after a failed transaction while preserving the
  // rejection for the caller that initiated that transaction.
  dawWriteTail = result.catch(() => undefined);
  return result;
}

function cloneForStorage(value, label = "song document") {
  if (typeof structuredClone !== "function") {
    throw new DawStorageError("unavailable", "Structured cloning is unavailable; this browser cannot safely save DAW projects.");
  }
  try {
    return structuredClone(value);
  } catch (error) {
    throw storageError(error, "clone", `clone ${label}`);
  }
}

function validProjectId(projectId) {
  const id = String(projectId ?? "").trim();
  if (!id) throw new DawStorageError("invalid", "A non-empty DAW project id is required.");
  return id;
}

function validSchemaVersion(schemaVersion) {
  const version = Number(schemaVersion);
  if (!Number.isInteger(version) || version < 0) {
    throw new DawStorageError("invalid", "DAW schemaVersion must be a non-negative integer.");
  }
  return version;
}

function recoveryId(projectId, revision) {
  return JSON.stringify([projectId, revision]);
}

function recoveryFromCurrent(current, fallbackReason) {
  if (!current || !Number.isInteger(current.revision)) return null;
  return {
    id: recoveryId(current.id, current.revision),
    projectId: current.id,
    revision: current.revision,
    savedAt: current.savedAt || Date.now(),
    schemaVersion: current.schemaVersion,
    reason: current.reason || fallbackReason || "autosave",
    data: current.data,
  };
}

function sortRecoveries(records) {
  return [...records].sort((a, b) =>
    (b.revision || 0) - (a.revision || 0)
    || (b.savedAt || 0) - (a.savedAt || 0)
    || String(b.id).localeCompare(String(a.id)));
}

function getProjectRecoveries(store, projectId) {
  try {
    return store.index(RECOVERY_PROJECT_INDEX).getAll(projectId);
  } catch {
    // Defensive fallback for a partially-created database. The normal v2
    // upgrade always creates the index.
    return store.getAll();
  }
}

function transactionFailure(transaction, action) {
  return storageError(transaction?.error, "transaction", action);
}

/**
 * Atomically read current + recoveries, apply `makePlan`, and commit its
 * replacement current record and recovery changes.
 */
function replaceDawCurrent(db, projectId, action, makePlan) {
  return new Promise((resolve, reject) => {
    let t;
    try {
      t = db.transaction([DAW_SONG_STORE, DAW_RECOVERY_STORE], "readwrite");
    } catch (error) {
      reject(storageError(error, "transaction", action));
      return;
    }
    const songs = t.objectStore(DAW_SONG_STORE);
    const recoveries = t.objectStore(DAW_RECOVERY_STORE);
    const currentReq = songs.get(projectId);
    const recoveriesReq = getProjectRecoveries(recoveries, projectId);
    let currentReady = false, recoveriesReady = false;
    let current = null, existing = [];
    let output = null;
    let settled = false;

    const fail = (error) => {
      if (settled) return;
      settled = true;
      try { t.abort(); } catch {}
      reject(storageError(error, "transaction", action));
    };

    const issuePlan = () => {
      if (!currentReady || !recoveriesReady || settled) return;
      try {
        // The fallback getAll path may include other projects.
        existing = (existing || []).filter((r) => r?.projectId === projectId);
        const plan = makePlan(current, existing);
        output = plan.current;
        const watch = (request) => {
          request.onerror = () => fail(request.error);
          return request;
        };
        watch(songs.put(plan.current));
        if (plan.addRecovery) watch(recoveries.put(plan.addRecovery));
        for (const id of plan.deleteRecoveryIds || []) watch(recoveries.delete(id));
      } catch (error) {
        fail(error);
      }
    };

    currentReq.onsuccess = () => {
      current = currentReq.result || null;
      currentReady = true;
      issuePlan();
    };
    currentReq.onerror = () => fail(currentReq.error);
    recoveriesReq.onsuccess = () => {
      existing = recoveriesReq.result || [];
      recoveriesReady = true;
      issuePlan();
    };
    recoveriesReq.onerror = () => fail(recoveriesReq.error);
    t.oncomplete = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(cloneForStorage(output, "saved DAW record"));
      } catch (error) {
        reject(error);
      }
    };
    t.onerror = () => fail(transactionFailure(t, action));
    t.onabort = () => fail(transactionFailure(t, action));
  });
}

function recoveryDeletes(existing, added) {
  const byId = new Map(existing.map((r) => [r.id, r]));
  if (added) byId.set(added.id, added);
  return sortRecoveries(byId.values())
    .slice(MAX_DAW_RECOVERIES)
    .map((r) => r.id);
}

async function withStrictDb(action, fn) {
  const db = await openDb({ strict: true });
  try {
    return await fn(db);
  } catch (error) {
    throw storageError(error, "transaction", action);
  } finally {
    db.close();
  }
}

function readOne(db, storeName, key, action) {
  return new Promise((resolve, reject) => {
    let t, req;
    try {
      t = db.transaction(storeName, "readonly");
      req = t.objectStore(storeName).get(key);
    } catch (error) {
      reject(storageError(error, "transaction", action));
      return;
    }
    let value = null, settled = false;
    req.onsuccess = () => { value = req.result || null; };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      reject(storageError(req.error, "transaction", action));
    };
    t.oncomplete = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(value == null ? null : cloneForStorage(value, "loaded DAW record"));
      } catch (error) {
        reject(error);
      }
    };
    t.onerror = () => {
      if (settled) return;
      settled = true;
      reject(transactionFailure(t, action));
    };
    t.onabort = t.onerror;
  });
}

function readRecoveries(db, projectId, action) {
  return new Promise((resolve, reject) => {
    let t, req;
    try {
      t = db.transaction(DAW_RECOVERY_STORE, "readonly");
      req = getProjectRecoveries(t.objectStore(DAW_RECOVERY_STORE), projectId);
    } catch (error) {
      reject(storageError(error, "transaction", action));
      return;
    }
    let records = [], settled = false;
    req.onsuccess = () => {
      records = (req.result || []).filter((r) => r?.projectId === projectId);
    };
    req.onerror = () => {
      if (settled) return;
      settled = true;
      reject(storageError(req.error, "transaction", action));
    };
    t.oncomplete = () => {
      if (settled) return;
      settled = true;
      try {
        resolve(cloneForStorage(sortRecoveries(records), "DAW recovery records"));
      } catch (error) {
        reject(error);
      }
    };
    t.onerror = () => {
      if (settled) return;
      settled = true;
      reject(transactionFailure(t, action));
    };
    t.onabort = t.onerror;
  });
}

/**
 * Load the current DAW record after all writes already queued by this module.
 * Returns null when no record exists; storage failures reject DawStorageError.
 */
export async function loadDawSong(projectId = "current") {
  const id = validProjectId(projectId);
  await dawWriteTail;
  return withStrictDb("load DAW song", (db) => readOne(db, DAW_SONG_STORE, id, "load DAW song"));
}

/**
 * Queue an atomic project save. The input document is structured-cloned before
 * it enters the queue, so later UI mutation cannot change the pending snapshot.
 *
 * Returns the saved current record:
 * { id, projectId, revision, savedAt, schemaVersion, reason, data }.
 */
export async function saveDawSong(projectId, schemaVersion, data, { reason = "autosave" } = {}) {
  const id = validProjectId(projectId);
  const version = validSchemaVersion(schemaVersion);
  const snapshot = cloneForStorage(data);
  const requestedAt = Date.now();
  return queueDawWrite(() => withStrictDb("save DAW song", async (db) =>
    replaceDawCurrent(db, id, "save DAW song", (current, existing) => {
      const maxRevision = Math.max(
        current?.revision || 0,
        ...existing.map((r) => r?.revision || 0),
      );
      const previous = recoveryFromCurrent(current, "autosave");
      const next = {
        id,
        projectId: id,
        revision: maxRevision + 1,
        savedAt: requestedAt,
        schemaVersion: version,
        reason: String(reason || "autosave"),
        data: snapshot,
      };
      return {
        current: next,
        addRecovery: previous,
        deleteRecoveryIds: recoveryDeletes(existing, previous),
      };
    })));
}

/** Return up to three recovery records, newest revision first. */
export async function listDawRecoveries(projectId = "current") {
  const id = validProjectId(projectId);
  await dawWriteTail;
  return withStrictDb(
    "list DAW recoveries",
    (db) => readRecoveries(db, id, "list DAW recoveries"),
  );
}

/**
 * Restore a recovery atomically while first preserving the current document.
 * Call as restoreDawRecovery(projectId, recoveryIdOrRevision), or pass one
 * argument to restore a recovery for the default "current" project.
 */
export async function restoreDawRecovery(projectId, recoveryIdOrRevision) {
  let id = projectId;
  let selector = recoveryIdOrRevision;
  if (selector === undefined) {
    selector = id;
    id = "current";
  }
  id = validProjectId(id);
  if (selector == null || selector === "") {
    return Promise.reject(new DawStorageError("invalid", "A recovery id or revision is required."));
  }
  const restoredAt = Date.now();
  return queueDawWrite(() => withStrictDb("restore DAW recovery", async (db) =>
    replaceDawCurrent(db, id, "restore DAW recovery", (current, existing) => {
      const target = existing.find((r) =>
        r.id === selector || (Number.isInteger(Number(selector)) && r.revision === Number(selector)));
      if (!target) {
        throw new DawStorageError("not-found", `DAW recovery ${String(selector)} was not found for project ${id}.`);
      }
      const maxRevision = Math.max(
        current?.revision || 0,
        ...existing.map((r) => r?.revision || 0),
      );
      const previous = recoveryFromCurrent(current, "before-recovery");
      const next = {
        id,
        projectId: id,
        revision: maxRevision + 1,
        savedAt: restoredAt,
        schemaVersion: validSchemaVersion(target.schemaVersion),
        reason: "recovery",
        restoredFromRevision: target.revision,
        data: cloneForStorage(target.data, "recovered song document"),
      };
      return {
        current: next,
        addRecovery: previous,
        deleteRecoveryIds: recoveryDeletes(existing, previous),
      };
    })));
}

/** Delete one recovery by the opaque `id` returned from listDawRecoveries(). */
export async function deleteDawRecovery(id) {
  const recoveryKey = String(id ?? "");
  if (!recoveryKey) {
    return Promise.reject(new DawStorageError("invalid", "A recovery id is required."));
  }
  return queueDawWrite(() => withStrictDb("delete DAW recovery", (db) =>
    new Promise((resolve, reject) => {
      let t, store, getReq;
      try {
        t = db.transaction(DAW_RECOVERY_STORE, "readwrite");
        store = t.objectStore(DAW_RECOVERY_STORE);
        getReq = store.get(recoveryKey);
      } catch (error) {
        reject(storageError(error, "transaction", "delete DAW recovery"));
        return;
      }
      let existed = false, settled = false;
      getReq.onsuccess = () => {
        existed = getReq.result != null;
        if (existed) {
          const deleteReq = store.delete(recoveryKey);
          deleteReq.onerror = () => {
            if (settled) return;
            settled = true;
            try { t.abort(); } catch {}
            reject(storageError(deleteReq.error, "transaction", "delete DAW recovery"));
          };
        }
      };
      getReq.onerror = () => {
        if (settled) return;
        settled = true;
        try { t.abort(); } catch {}
        reject(storageError(getReq.error, "transaction", "delete DAW recovery"));
      };
      t.oncomplete = () => {
        if (settled) return;
        settled = true;
        resolve(existed);
      };
      t.onerror = () => {
        if (settled) return;
        settled = true;
        reject(transactionFailure(t, "delete DAW recovery"));
      };
      t.onabort = t.onerror;
    })));
}
