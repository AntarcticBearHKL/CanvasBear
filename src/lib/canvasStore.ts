type StoredCanvas = {
  nodes: unknown[];
  wires: unknown[];
};

const DB_NAME = "open-canvas-store";
const STORE_NAME = "canvases";
const IMAGE_STORE = "images";
let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
      if (!db.objectStoreNames.contains(IMAGE_STORE)) {
        db.createObjectStore(IMAGE_STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
  });
  return dbPromise;
}

export async function loadStoredCanvas(canvasId: string): Promise<StoredCanvas | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readonly");
    const request = transaction.objectStore(STORE_NAME).get(canvasId);
    request.onsuccess = () => resolve((request.result as StoredCanvas | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB read failed"));
  });
}

export async function saveStoredCanvas(canvasId: string, payload: StoredCanvas): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).put(payload, canvasId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB write aborted"));
  });
}

export async function deleteStoredCanvas(canvasId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, "readwrite");
    transaction.objectStore(STORE_NAME).delete(canvasId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB delete failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB delete aborted"));
  });
}

/**
 * Text nodes were removed from the canvas model. Strip them, their wires and
 * any stray text field from every stored canvas once at startup so old
 * documents never come back.
 */
export async function stripTextNodesFromStoredCanvases(): Promise<number> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    let changed = 0;
    const transaction = db.transaction(STORE_NAME, "readwrite");
    const store = transaction.objectStore(STORE_NAME);
    const request = store.openCursor();
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) return;
      const payload = cursor.value as StoredCanvas | undefined;
      const nodes = Array.isArray(payload?.nodes) ? payload.nodes : [];
      const textIds = new Set(
        nodes
          .filter((node): node is { id?: unknown; kind?: unknown } => Boolean(node) && typeof node === "object" && (node as { kind?: unknown }).kind === "text")
          .map((node) => String(node.id ?? "")),
      );
      const cleanNodes: unknown[] = [];
      let didChange = false;
      for (const node of nodes) {
        if (!node || typeof node !== "object") {
          cleanNodes.push(node);
          continue;
        }
        if ((node as { kind?: unknown }).kind === "text") {
          didChange = true;
          continue;
        }
        if ("text" in node) {
          didChange = true;
          const copy = { ...(node as Record<string, unknown>) };
          delete copy.text;
          cleanNodes.push(copy);
          continue;
        }
        cleanNodes.push(node);
      }
      const wires = Array.isArray(payload?.wires) ? payload.wires : [];
      const cleanWires = wires.filter(
        (wire) =>
          !(
            wire &&
            typeof wire === "object" &&
            (textIds.has(String((wire as { from?: unknown }).from ?? "")) ||
              textIds.has(String((wire as { to?: unknown }).to ?? "")))
          ),
      );
      if (didChange || cleanWires.length !== wires.length) {
        changed += 1;
        cursor.update({ ...payload, nodes: cleanNodes, wires: cleanWires });
      }
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(changed);
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB migration failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB migration aborted"));
  });
}

export async function loadStoredImage(imageId: string): Promise<string | null> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE, "readonly");
    const request = transaction.objectStore(IMAGE_STORE).get(imageId);
    request.onsuccess = () => resolve((request.result as string | undefined) ?? null);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB image read failed"));
  });
}

export async function saveStoredImage(imageId: string, dataUrl: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE, "readwrite");
    transaction.objectStore(IMAGE_STORE).put(dataUrl, imageId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB image write failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB image write aborted"));
  });
}

export async function deleteStoredImage(imageId: string): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(IMAGE_STORE, "readwrite");
    transaction.objectStore(IMAGE_STORE).delete(imageId);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB image delete failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB image delete aborted"));
  });
}
