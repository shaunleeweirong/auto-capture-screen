// IndexedDB layer. Screenshots are stored as Blobs (no base64 tax); guide
// metadata is stored as plain objects. Accessible from the service worker,
// side panel, and editor (all share the extension origin).

import type { Guide, GuideSummary, Step } from './types';

const DB_NAME = 'guidely';
const DB_VERSION = 1;
const STORE_GUIDES = 'guides';
const STORE_IMAGES = 'images';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_GUIDES)) {
        db.createObjectStore(STORE_GUIDES, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(STORE_IMAGES)) {
        db.createObjectStore(STORE_IMAGES);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ---- Images ----

export async function putImage(id: string, blob: Blob): Promise<void> {
  const db = await openDb();
  await reqToPromise(db.transaction(STORE_IMAGES, 'readwrite').objectStore(STORE_IMAGES).put(blob, id));
}

export async function getImage(id: string): Promise<Blob | undefined> {
  const db = await openDb();
  return reqToPromise(db.transaction(STORE_IMAGES, 'readonly').objectStore(STORE_IMAGES).get(id));
}

export async function deleteImage(id: string): Promise<void> {
  const db = await openDb();
  await reqToPromise(db.transaction(STORE_IMAGES, 'readwrite').objectStore(STORE_IMAGES).delete(id));
}

// ---- Guides ----

export async function putGuide(guide: Guide): Promise<void> {
  const db = await openDb();
  await reqToPromise(db.transaction(STORE_GUIDES, 'readwrite').objectStore(STORE_GUIDES).put(guide));
}

export async function getGuide(id: string): Promise<Guide | undefined> {
  const db = await openDb();
  return reqToPromise(db.transaction(STORE_GUIDES, 'readonly').objectStore(STORE_GUIDES).get(id));
}

export async function getAllGuides(): Promise<Guide[]> {
  const db = await openDb();
  const all = await reqToPromise<Guide[]>(
    db.transaction(STORE_GUIDES, 'readonly').objectStore(STORE_GUIDES).getAll(),
  );
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function listGuideSummaries(): Promise<GuideSummary[]> {
  const guides = await getAllGuides();
  return guides.map((g) => ({
    id: g.id,
    title: g.title,
    createdAt: g.createdAt,
    updatedAt: g.updatedAt,
    stepCount: g.steps.length,
  }));
}

export async function deleteGuide(id: string): Promise<void> {
  const guide = await getGuide(id);
  if (guide) {
    await Promise.all(guide.steps.map((s) => deleteImage(s.imageId).catch(() => {})));
  }
  const db = await openDb();
  await reqToPromise(db.transaction(STORE_GUIDES, 'readwrite').objectStore(STORE_GUIDES).delete(id));
}

// Append a step inside a single read-modify-write transaction. The capture
// queue is serial, so there is no concurrent append race. Returns new length.
export async function appendStep(guideId: string, step: Step): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_GUIDES, 'readwrite');
    const store = t.objectStore(STORE_GUIDES);
    const getReq = store.get(guideId);
    getReq.onsuccess = () => {
      const guide: Guide | undefined = getReq.result;
      if (!guide) {
        reject(new Error(`Guide ${guideId} not found`));
        return;
      }
      step.order = guide.steps.length;
      guide.steps.push(step);
      guide.updatedAt = Date.now();
      const putReq = store.put(guide);
      putReq.onsuccess = () => resolve(guide.steps.length);
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}
