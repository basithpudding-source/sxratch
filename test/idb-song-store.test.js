import test from "node:test";
import assert from "node:assert/strict";

import {
  collectDawClipIds,
  DawStorageError,
  deleteDawRecovery,
  listDawRecoveries,
  loadAllSamples,
  loadDawSong,
  restoreDawRecovery,
  saveDawSong,
  shouldPreferDawFallback,
} from "../js/idb-store.js";
import { readVersionedRecord, writeVersioned } from "../js/store.js";

class FakeNameList {
  constructor(names) { this.names = names; }
  contains(name) { return this.names().includes(name); }
  [Symbol.iterator]() { return this.names()[Symbol.iterator](); }
}

const clone = (value) => structuredClone(value);

function cloneStore(source) {
  return {
    keyPath: source.keyPath,
    records: new Map([...source.records].map(([key, value]) => [key, clone(value)])),
    indexes: new Map([...source.indexes].map(([name, spec]) => [name, clone(spec)])),
  };
}

class FakeTransaction {
  constructor(connection, storeNames, mode) {
    this.connection = connection;
    this.mode = mode;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.pending = 0;
    this.aborted = false;
    this.finished = false;
    this.completionQueued = false;
    const names = Array.isArray(storeNames) ? storeNames : [storeNames];
    this.stores = new Map();
    for (const name of names) {
      const source = connection.state.stores.get(name);
      if (!source) throw new DOMException(`Missing store ${name}`, "NotFoundError");
      this.stores.set(name, mode === "readwrite" ? cloneStore(source) : source);
    }
  }

  objectStore(name) {
    const data = this.stores.get(name);
    if (!data) throw new DOMException(`Store ${name} is outside the transaction`, "NotFoundError");
    return new FakeObjectStore(this, name, data);
  }

  request(operation) {
    if (this.finished || this.aborted) throw new DOMException("Transaction is inactive", "TransactionInactiveError");
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.pending++;
    queueMicrotask(() => {
      if (this.aborted) {
        this.pending--;
        this.queueCompletion();
        return;
      }
      try {
        request.result = operation();
        request.onsuccess?.({ target: request });
      } catch (error) {
        request.error = error;
        request.onerror?.({ target: request, preventDefault() {} });
        this.fail(error);
      } finally {
        this.pending--;
        this.queueCompletion();
      }
    });
    return request;
  }

  fail(error) {
    if (this.finished || this.aborted) return;
    this.error = error;
    this.aborted = true;
    queueMicrotask(() => {
      this.onerror?.({ target: this });
      this.onabort?.({ target: this });
    });
  }

  abort() {
    if (this.finished || this.aborted) return;
    this.error ||= new DOMException("Transaction aborted", "AbortError");
    this.aborted = true;
    queueMicrotask(() => this.onabort?.({ target: this }));
  }

  queueCompletion() {
    if (this.completionQueued || this.pending || this.finished || this.aborted) return;
    this.completionQueued = true;
    queueMicrotask(() => {
      this.completionQueued = false;
      if (this.pending || this.finished || this.aborted) return;
      this.finished = true;
      if (this.mode === "readwrite") {
        for (const [name, data] of this.stores) this.connection.state.stores.set(name, data);
      }
      this.oncomplete?.({ target: this });
    });
  }
}

class FakeObjectStore {
  constructor(transaction, name, data, connection = transaction?.connection) {
    this.transaction = transaction;
    this.name = name;
    this.data = data;
    this.connection = connection;
    this.indexNames = new FakeNameList(() => [...data.indexes.keys()]);
  }

  createIndex(name, keyPath, options = {}) {
    this.data.indexes.set(name, { keyPath, unique: !!options.unique });
    return this.index(name);
  }

  index(name) {
    const spec = this.data.indexes.get(name);
    if (!spec) throw new DOMException(`Missing index ${name}`, "NotFoundError");
    return {
      getAll: (query) => this.transaction.request(() => {
        const records = [...this.data.records.values()].filter((record) => {
          const indexValue = Array.isArray(spec.keyPath)
            ? spec.keyPath.map((part) => record[part])
            : record[spec.keyPath];
          return query === undefined || JSON.stringify(indexValue) === JSON.stringify(query);
        });
        return clone(records);
      }),
    };
  }

  get(key) {
    return this.transaction.request(() => {
      const value = this.data.records.get(key);
      return value === undefined ? undefined : clone(value);
    });
  }

  getAll() {
    return this.transaction.request(() => clone([...this.data.records.values()]));
  }

  put(value) {
    if (this.transaction.mode !== "readwrite") throw new DOMException("Readonly transaction", "ReadOnlyError");
    return this.transaction.request(() => {
      if (this.connection.factory.failNextPutStore === this.name) {
        this.connection.factory.failNextPutStore = null;
        throw new DOMException("Injected quota failure", "QuotaExceededError");
      }
      const saved = clone(value);
      const key = saved[this.data.keyPath];
      if (key === undefined) throw new DOMException("Missing key", "DataError");
      this.data.records.set(key, saved);
      return key;
    });
  }

  delete(key) {
    if (this.transaction.mode !== "readwrite") throw new DOMException("Readonly transaction", "ReadOnlyError");
    return this.transaction.request(() => {
      this.data.records.delete(key);
      return undefined;
    });
  }
}

class FakeConnection {
  constructor(factory, state) {
    this.factory = factory;
    this.state = state;
    this.onversionchange = null;
    this.objectStoreNames = new FakeNameList(() => [...state.stores.keys()]);
  }

  createObjectStore(name, { keyPath }) {
    if (this.state.stores.has(name)) throw new DOMException(`Store ${name} exists`, "ConstraintError");
    const data = { keyPath, records: new Map(), indexes: new Map() };
    this.state.stores.set(name, data);
    return new FakeObjectStore(null, name, data, this);
  }

  transaction(storeNames, mode = "readonly") {
    return new FakeTransaction(this, storeNames, mode);
  }

  close() {}
}

class FakeIndexedDB {
  constructor() {
    this.databases = new Map();
    this.failNextPutStore = null;
  }

  open(name, requestedVersion) {
    const request = {
      result: null,
      transaction: null,
      error: null,
      onupgradeneeded: null,
      onsuccess: null,
      onerror: null,
      onblocked: null,
    };
    queueMicrotask(() => {
      let state = this.databases.get(name);
      if (!state) {
        state = { version: 0, stores: new Map() };
        this.databases.set(name, state);
      }
      const version = requestedVersion ?? Math.max(1, state.version);
      if (version < state.version) {
        request.error = new DOMException("Requested version is too old", "VersionError");
        request.onerror?.({ target: request });
        return;
      }
      const connection = new FakeConnection(this, state);
      request.result = connection;
      if (version > state.version) {
        const upgradeTransaction = {
          error: null,
          aborted: false,
          objectStore: (storeName) => {
            const data = state.stores.get(storeName);
            if (!data) throw new DOMException(`Missing store ${storeName}`, "NotFoundError");
            return new FakeObjectStore(null, storeName, data, connection);
          },
          abort() {
            this.aborted = true;
            this.error = new DOMException("Upgrade aborted", "AbortError");
          },
        };
        request.transaction = upgradeTransaction;
        request.onupgradeneeded?.({
          oldVersion: state.version,
          newVersion: version,
          target: request,
        });
        if (upgradeTransaction.aborted) {
          request.error = upgradeTransaction.error;
          request.onerror?.({ target: request });
          return;
        }
        state.version = version;
      }
      request.onsuccess?.({ target: request });
    });
    return request;
  }

  seedStore(dbName, version, storeName, keyPath, records) {
    let state = this.databases.get(dbName);
    if (!state) {
      state = { version, stores: new Map() };
      this.databases.set(dbName, state);
    }
    state.version = version;
    state.stores.set(storeName, {
      keyPath,
      records: new Map(records.map((record) => [record[keyPath], clone(record)])),
      indexes: new Map(),
    });
  }
}

function freshDatabase() {
  const fake = new FakeIndexedDB();
  globalThis.indexedDB = fake;
  return fake;
}

test("fallback freshness uses the observed IDB revision before timestamps", () => {
  const marker = { failedAt: 2000, baseRevision: 4 };
  assert.equal(
    shouldPreferDawFallback(marker, { revision: 4, savedAt: 9000 }),
    true,
    "the local snapshot follows the failed write against revision 4",
  );
  assert.equal(
    shouldPreferDawFallback(marker, { revision: 5, savedAt: 1000 }),
    false,
    "a later committed revision supersedes the fallback even with a skewed clock",
  );
  assert.equal(shouldPreferDawFallback(marker, null), true);
  assert.equal(shouldPreferDawFallback({}, { revision: 4, savedAt: 1000 }), false);
});

test("fallback freshness uses failure time when IDB was unreadable", () => {
  const marker = { failedAt: 2000, baseRevision: null };
  assert.equal(shouldPreferDawFallback(marker, { savedAt: 1999 }), true);
  assert.equal(shouldPreferDawFallback(marker, { savedAt: 2001 }), false);
});

test("a failed IDB save leaves a local snapshot that wins over stale current", { concurrency: false }, async () => {
  const fake = freshDatabase();
  const local = new Map();
  globalThis.localStorage = {
    getItem: (key) => local.get(key) ?? null,
    setItem: (key, value) => local.set(key, String(value)),
  };

  const current = await saveDawSong("current", 4, { value: "old" });
  fake.failNextPutStore = "daw-recovery";
  await assert.rejects(saveDawSong("current", 4, { value: "new" }));

  writeVersioned("sxratch.daw", 4, { value: "new" }, {
    metadata: {
      dawFallback: {
        failedAt: Date.now(),
        baseRevision: current.revision,
      },
    },
  });

  const staleIdb = await loadDawSong("current");
  const fallback = readVersionedRecord("sxratch.daw", 4);
  assert.deepEqual(staleIdb.data, { value: "old" });
  assert.deepEqual(fallback.data, { value: "new" });
  assert.equal(
    shouldPreferDawFallback(fallback.metadata.dawFallback, staleIdb),
    true,
  );

  const laterIdb = await saveDawSong("current", 4, { value: "later" });
  assert.equal(
    shouldPreferDawFallback(fallback.metadata.dawFallback, laterIdb),
    false,
    "a later committed IDB revision retires the old failure marker",
  );
});

test("clip references include current and retained recovery documents", { concurrency: false }, async () => {
  freshDatabase();
  const songWith = (clipId) => ({ tracks: [{ regions: [{ clipId }] }] });
  await saveDawSong("current", 4, songWith("dawclip:recovery-1"));
  await saveDawSong("current", 4, songWith("dawclip:recovery-2"));
  await saveDawSong("current", 4, songWith("dawclip:current"));

  const current = await loadDawSong("current");
  const recoveries = await listDawRecoveries("current");

  assert.deepEqual(
    [...collectDawClipIds([current, ...recoveries])].sort(),
    ["dawclip:current", "dawclip:recovery-1", "dawclip:recovery-2"],
  );
});

test("v1 to v2 upgrade preserves pad samples and adds DAW stores", { concurrency: false }, async () => {
  const fake = freshDatabase();
  fake.seedStore("sxratch", 1, "pad-samples", "id", [{
    id: "pad-one",
    name: "Kick",
    sampleRate: 48000,
    channels: [new Float32Array([0.25, -0.25])],
    bytes: 8,
    savedAt: 1,
    pinned: false,
  }]);

  const saved = await saveDawSong("current", 4, { bpm: 120, tracks: [] }, { reason: "migration" });
  assert.equal(saved.revision, 1);
  assert.deepEqual((await loadAllSamples()).map((sample) => sample.id), ["pad-one"]);

  const state = fake.databases.get("sxratch");
  assert.equal(state.version, 2);
  assert.deepEqual(
    [...state.stores.keys()].sort(),
    ["daw-recovery", "daw-songs", "pad-samples"],
  );
});

test("queued saves are ordered, cloned at call time, and retain three recoveries", { concurrency: false }, async () => {
  freshDatabase();
  const first = { value: 1, nested: { stable: true } };
  const cloneCheck = saveDawSong("clone-check", 4, first);
  first.value = 999;
  first.nested.stable = false;
  await cloneCheck;
  assert.deepEqual(
    (await loadDawSong("clone-check")).data,
    { value: 1, nested: { stable: true } },
  );

  const writes = [
    saveDawSong("current", 4, { value: 1 }),
    saveDawSong("current", 4, { value: 2 }),
    saveDawSong("current", 4, { value: 3 }),
    saveDawSong("current", 4, { value: 4 }),
    saveDawSong("current", 4, { value: 5 }),
  ];

  const results = await Promise.all(writes);
  assert.deepEqual(results.map((record) => record.revision), [1, 2, 3, 4, 5]);
  const current = await loadDawSong();
  assert.equal(current.revision, 5);
  assert.deepEqual(current.data, { value: 5 });

  const recoveries = await listDawRecoveries();
  assert.deepEqual(recoveries.map((record) => record.revision), [4, 3, 2]);
  assert.deepEqual(recoveries.find((record) => record.revision === 2).data, { value: 2 });
});

test("restore preserves current, advances revision, and recovery deletion is explicit", { concurrency: false }, async () => {
  freshDatabase();
  for (let value = 1; value <= 5; value++) {
    await saveDawSong("current", 4, { value });
  }
  const target = (await listDawRecoveries()).find((record) => record.revision === 3);
  const restored = await restoreDawRecovery("current", target.id);
  assert.equal(restored.revision, 6);
  assert.equal(restored.restoredFromRevision, 3);
  assert.deepEqual(restored.data, { value: 3 });

  const recoveries = await listDawRecoveries();
  assert.deepEqual(recoveries.map((record) => record.revision), [5, 4, 3]);
  const removable = recoveries.find((record) => record.revision === 4);
  assert.equal(await deleteDawRecovery(removable.id), true);
  assert.equal(await deleteDawRecovery(removable.id), false);
  assert.deepEqual((await listDawRecoveries()).map((record) => record.revision), [5, 3]);
});

test("failed replacement is atomic and does not poison the write queue", { concurrency: false }, async () => {
  const fake = freshDatabase();
  await saveDawSong("current", 4, { value: "safe" });
  // The staged current put succeeds first; failing the recovery put must still
  // roll the whole transaction back.
  fake.failNextPutStore = "daw-recovery";

  await assert.rejects(
    saveDawSong("current", 4, { value: "must-not-land" }),
    (error) => error instanceof DawStorageError && error.code === "quota",
  );
  assert.equal((await loadDawSong()).revision, 1);
  assert.deepEqual((await loadDawSong()).data, { value: "safe" });
  assert.deepEqual(await listDawRecoveries(), []);

  const next = await saveDawSong("current", 4, { value: "after-failure" });
  assert.equal(next.revision, 2);
  assert.deepEqual((await loadDawSong()).data, { value: "after-failure" });
});

test("DAW APIs reject unavailable storage and missing recovery with useful codes", { concurrency: false }, async () => {
  freshDatabase();
  await saveDawSong("current", 4, { value: 1 });
  await assert.rejects(
    restoreDawRecovery("current", 99),
    (error) => error instanceof DawStorageError && error.code === "not-found",
  );

  delete globalThis.indexedDB;
  await assert.rejects(
    loadDawSong(),
    (error) => error instanceof DawStorageError && error.code === "unavailable",
  );
});
