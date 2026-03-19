import type { Annotation } from "../types";

interface DraftRecord {
  key: string;
  documentId: string;
  pageId: string;
  annotations: Annotation[];
  annotationText: string;
  updatedAt: number;
}

interface DraftPayload {
  documentId: string;
  pageId: string;
  annotations: Annotation[];
  annotationText: string;
}

const DB_NAME = "inkflow-drafts";
const DB_VERSION = 1;
const STORE_NAME = "pageDrafts";
const DOCUMENT_INDEX = "byDocument";

let openDatabasePromise: Promise<IDBDatabase> | null = null;

function draftKey(documentId: string, pageId: string): string {
  return `${documentId}:${pageId}`;
}

function requestToPromise<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

async function openDatabase(): Promise<IDBDatabase | null> {
  if (typeof indexedDB === "undefined") {
    return null;
  }

  if (!openDatabasePromise) {
    openDatabasePromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        const store = database.objectStoreNames.contains(STORE_NAME)
          ? request.transaction?.objectStore(STORE_NAME)
          : database.createObjectStore(STORE_NAME, { keyPath: "key" });

        if (store && !store.indexNames.contains(DOCUMENT_INDEX)) {
          store.createIndex(DOCUMENT_INDEX, "documentId", { unique: false });
        }
      };

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("Could not open IndexedDB."));
    });
  }

  return openDatabasePromise;
}

export async function saveDraft(payload: DraftPayload): Promise<void> {
  const database = await openDatabase();
  if (!database) {
    return;
  }

  const transaction = database.transaction(STORE_NAME, "readwrite");
  const store = transaction.objectStore(STORE_NAME);
  store.put({
    key: draftKey(payload.documentId, payload.pageId),
    documentId: payload.documentId,
    pageId: payload.pageId,
    annotations: payload.annotations,
    annotationText: payload.annotationText,
    updatedAt: Date.now()
  } satisfies DraftRecord);

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not persist draft."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Draft transaction aborted."));
  });
}

export async function deleteDraft(documentId: string, pageId: string): Promise<void> {
  const database = await openDatabase();
  if (!database) {
    return;
  }

  const transaction = database.transaction(STORE_NAME, "readwrite");
  transaction.objectStore(STORE_NAME).delete(draftKey(documentId, pageId));

  await new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("Could not delete draft."));
    transaction.onabort = () => reject(transaction.error ?? new Error("Draft delete aborted."));
  });
}

export async function getDraftsForDocument(documentId: string): Promise<Map<string, DraftRecord>> {
  const database = await openDatabase();
  if (!database) {
    return new Map();
  }

  const transaction = database.transaction(STORE_NAME, "readonly");
  const store = transaction.objectStore(STORE_NAME);
  const index = store.index(DOCUMENT_INDEX);
  const records = await requestToPromise(index.getAll(documentId));

  return new Map((records as DraftRecord[]).map((record) => [record.pageId, record]));
}
