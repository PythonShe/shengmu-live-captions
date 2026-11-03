const DB_NAME = "shengmu-caption-history";
const DB_VERSION = 1;
const SESSION_STORE = "sessions";
const LINE_STORE = "lines";

let databasePromise = null;

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("IndexedDB request failed"));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error || new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      reject(transaction.error || new Error("IndexedDB transaction aborted"));
  });
}

export function openHistoryDb() {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(SESSION_STORE)) {
        const sessions = database.createObjectStore(SESSION_STORE, { keyPath: "id" });
        sessions.createIndex("startedAt", "startedAt");
      }
      if (!database.objectStoreNames.contains(LINE_STORE)) {
        const lines = database.createObjectStore(LINE_STORE, { keyPath: "id" });
        lines.createIndex("sessionId", "sessionId");
        lines.createIndex("sessionId_order", ["sessionId", "order"]);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      databasePromise = null;
      reject(request.error || new Error("Unable to open caption history"));
    };
  });
  return databasePromise;
}

export async function createHistorySession(metadata) {
  const database = await openHistoryDb();
  const transaction = database.transaction(SESSION_STORE, "readwrite");
  transaction.objectStore(SESSION_STORE).put({
    id: metadata.id,
    startedAt: metadata.startedAt,
    endedAt: metadata.endedAt || null,
    updatedAt: metadata.updatedAt || metadata.startedAt,
    title: metadata.title || "未命名直播",
    url: metadata.url || "",
    tabId: metadata.tabId ?? null,
    wsUrl: metadata.wsUrl || "",
    translationMode: metadata.translationMode || "",
    translationProvider: metadata.translationProvider || "",
    translationModel: metadata.translationModel || "",
    status: metadata.status || "capturing",
    lineCount: Number(metadata.lineCount) || 0,
    preview: metadata.preview || ""
  });
  await transactionDone(transaction);
  return metadata.id;
}

export async function updateHistorySession(sessionId, patch) {
  if (!sessionId) return;
  const database = await openHistoryDb();
  const transaction = database.transaction(SESSION_STORE, "readwrite");
  const store = transaction.objectStore(SESSION_STORE);
  const done = transactionDone(transaction);
  const request = store.get(sessionId);
  request.onsuccess = () => {
    const current = request.result;
    if (!current) return;
    store.put({
      ...current,
      ...patch,
      id: sessionId,
      updatedAt: patch.updatedAt || Date.now()
    });
  };
  request.onerror = () => {
    transaction.abort();
  };
  await done;
}

export async function upsertHistoryLines(lines) {
  const validLines = (lines || []).filter((line) => line?.id && line?.sessionId);
  if (validLines.length === 0) return;
  const database = await openHistoryDb();
  const transaction = database.transaction(LINE_STORE, "readwrite");
  const store = transaction.objectStore(LINE_STORE);
  for (const line of validLines) {
    store.put(line);
  }
  await transactionDone(transaction);
}

export async function countHistoryLines(sessionId) {
  const database = await openHistoryDb();
  const transaction = database.transaction(LINE_STORE, "readonly");
  const index = transaction.objectStore(LINE_STORE).index("sessionId");
  const count = await requestToPromise(index.count(IDBKeyRange.only(sessionId)));
  await transactionDone(transaction);
  return count;
}

export async function listHistorySessions() {
  const database = await openHistoryDb();
  const transaction = database.transaction(SESSION_STORE, "readonly");
  const sessions = await requestToPromise(
    transaction.objectStore(SESSION_STORE).getAll()
  );
  await transactionDone(transaction);
  return sessions.sort(
    (left, right) => (right.startedAt || 0) - (left.startedAt || 0)
  );
}

export async function getHistorySession(sessionId) {
  if (!sessionId) return null;
  const database = await openHistoryDb();
  const transaction = database.transaction(SESSION_STORE, "readonly");
  const session = await requestToPromise(
    transaction.objectStore(SESSION_STORE).get(sessionId)
  );
  await transactionDone(transaction);
  return session || null;
}

export async function getHistoryLines(sessionId) {
  if (!sessionId) return [];
  const database = await openHistoryDb();
  const transaction = database.transaction(LINE_STORE, "readonly");
  const index = transaction.objectStore(LINE_STORE).index("sessionId_order");
  const range = IDBKeyRange.bound([sessionId, -Infinity], [sessionId, Infinity]);
  const lines = await requestToPromise(index.getAll(range));
  await transactionDone(transaction);
  return lines;
}

export async function deleteHistorySession(sessionId) {
  if (!sessionId) return;
  const database = await openHistoryDb();
  const transaction = database.transaction(
    [SESSION_STORE, LINE_STORE],
    "readwrite"
  );
  const sessionStore = transaction.objectStore(SESSION_STORE);
  const lineStore = transaction.objectStore(LINE_STORE);
  const lineIndex = lineStore.index("sessionId");
  const cursorRequest = lineIndex.openKeyCursor(IDBKeyRange.only(sessionId));
  cursorRequest.onsuccess = () => {
    const cursor = cursorRequest.result;
    if (!cursor) return;
    lineStore.delete(cursor.primaryKey);
    cursor.continue();
  };
  sessionStore.delete(sessionId);
  await transactionDone(transaction);
}

export async function clearHistory() {
  const database = await openHistoryDb();
  const transaction = database.transaction(
    [SESSION_STORE, LINE_STORE],
    "readwrite"
  );
  transaction.objectStore(SESSION_STORE).clear();
  transaction.objectStore(LINE_STORE).clear();
  await transactionDone(transaction);
}
