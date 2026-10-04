import type { PersistenceAdapter } from "./types.js";

/** Default adapter: nothing survives a restart (unsent messages are lost when the app is killed). */
export function memoryPersistence(): PersistenceAdapter {
  const m = new Map<string, string>();
  return {
    get: async (k) => m.get(k) ?? null,
    set: async (k, v) => void m.set(k, v),
    delete: async (k) => void m.delete(k),
  };
}

/** Browser localStorage adapter (per-origin, per-user keys are namespaced by the SDK). */
export function localStoragePersistence(storage: Storage = globalThis.localStorage): PersistenceAdapter {
  return {
    get: async (k) => {
      try {
        return storage.getItem(k);
      } catch {
        return null;
      }
    },
    set: async (k, v) => {
      try {
        storage.setItem(k, v);
      } catch {
        /* quota or disabled storage: keep running in memory */
      }
    },
    delete: async (k) => {
      try {
        storage.removeItem(k);
      } catch {
        /* ignore */
      }
    },
  };
}
