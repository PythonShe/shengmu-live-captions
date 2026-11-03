// The subset of IndexedDB that extension/storage/history-db.js uses, held in
// memory. Requests settle on the next macrotask and a transaction completes
// once no request is outstanding, which is the ordering history-db relies on.

function rank(value) {
  if (Array.isArray(value)) return 3;
  return typeof value === "string" ? 2 : 1;
}

function compareKeys(left, right) {
  if (rank(left) !== rank(right)) return rank(left) - rank(right);
  if (Array.isArray(left)) {
    for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
      const result = compareKeys(left[index], right[index]);
      if (result !== 0) return result;
    }
    return left.length - right.length;
  }
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

class FakeKeyRange {
  constructor(lower, upper) {
    this.lower = lower;
    this.upper = upper;
  }

  includes(key) {
    return compareKeys(key, this.lower) >= 0 && compareKeys(key, this.upper) <= 0;
  }

  static only(value) {
    return new FakeKeyRange(value, value);
  }

  static bound(lower, upper) {
    return new FakeKeyRange(lower, upper);
  }
}

function keyOf(value, keyPath) {
  if (Array.isArray(keyPath)) {
    const parts = keyPath.map((part) => value?.[part]);
    return parts.some((part) => part === undefined) ? undefined : parts;
  }
  return value?.[keyPath];
}

class FakeTransaction {
  constructor(database) {
    this.database = database;
    this.outstanding = 0;
    this.finished = false;
    this.error = null;
    this.oncomplete = null;
    this.onerror = null;
    this.onabort = null;
    this.settle();
  }

  objectStore(name) {
    const definition = this.database.stores.get(name);
    if (!definition) throw new Error(`no object store ${name}`);
    return new FakeObjectStore(this, definition);
  }

  request(run) {
    const request = { result: undefined, error: null, onsuccess: null, onerror: null };
    this.outstanding += 1;
    setImmediate(() => {
      if (this.finished) return;
      try {
        request.result = run();
      } catch (error) {
        request.error = error;
        this.outstanding -= 1;
        request.onerror?.();
        this.abort(error);
        return;
      }
      request.onsuccess?.({ target: request });
      this.outstanding -= 1;
      this.settle();
    });
    return request;
  }

  settle() {
    setImmediate(() => {
      if (this.finished || this.outstanding > 0) return;
      this.finished = true;
      this.oncomplete?.();
    });
  }

  abort(error = null) {
    if (this.finished) return;
    this.finished = true;
    this.error = error;
    this.onabort?.();
  }
}

class FakeIndex {
  constructor(transaction, definition, keyPath) {
    this.transaction = transaction;
    this.definition = definition;
    this.keyPath = keyPath;
  }

  matching(range) {
    return [...this.definition.records.values()]
      .map((record) => ({ key: keyOf(record, this.keyPath), record }))
      .filter(({ key }) => key !== undefined && (!range || range.includes(key)))
      .sort((left, right) => compareKeys(left.key, right.key))
      .map(({ record }) => structuredClone(record));
  }

  count(range) {
    return this.transaction.request(() => this.matching(range).length);
  }

  getAll(range) {
    return this.transaction.request(() => this.matching(range));
  }
}

class FakeObjectStore {
  constructor(transaction, definition) {
    this.transaction = transaction;
    this.definition = definition;
  }

  put(value) {
    return this.transaction.request(() => {
      const key = keyOf(value, this.definition.keyPath);
      this.definition.records.set(key, structuredClone(value));
      return key;
    });
  }

  get(key) {
    return this.transaction.request(() => structuredClone(this.definition.records.get(key)));
  }

  getAll() {
    return this.transaction.request(() =>
      [...this.definition.records.values()].map((record) => structuredClone(record))
    );
  }

  delete(key) {
    return this.transaction.request(() => {
      this.definition.records.delete(key);
    });
  }

  clear() {
    return this.transaction.request(() => {
      this.definition.records.clear();
    });
  }

  index(name) {
    const keyPath = this.definition.indexes.get(name);
    if (!keyPath) throw new Error(`no index ${name}`);
    return new FakeIndex(this.transaction, this.definition, keyPath);
  }
}

class FakeDatabase {
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = { contains: (name) => this.stores.has(name) };
  }

  createObjectStore(name, { keyPath }) {
    const definition = { keyPath, records: new Map(), indexes: new Map() };
    this.stores.set(name, definition);
    return {
      createIndex: (indexName, indexKeyPath) => {
        definition.indexes.set(indexName, indexKeyPath);
      }
    };
  }

  transaction() {
    return new FakeTransaction(this);
  }
}

export function installFakeIndexedDb() {
  const databases = new Map();
  globalThis.IDBKeyRange = FakeKeyRange;
  globalThis.indexedDB = {
    open(name) {
      const request = { result: null, error: null, onsuccess: null, onerror: null, onupgradeneeded: null };
      setImmediate(() => {
        let database = databases.get(name);
        if (!database) {
          database = new FakeDatabase();
          databases.set(name, database);
          request.result = database;
          request.onupgradeneeded?.();
        }
        request.result = database;
        request.onsuccess?.();
      });
      return request;
    }
  };
  return databases;
}
