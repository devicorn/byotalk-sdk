// React Native helpers (`byotalk/react-native`): app lifecycle, network changes, persistence adapters.
// Peer dependencies are optional and loaded only by the adapter that needs them.
import { AppState, type AppStateStatus } from "react-native";
import { Chat, type ChatOptions, type PersistenceAdapter } from "../core/index.js";

// Metro resolves optional peers through require(); missing ones throw and are skipped.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
declare const require: (id: string) => any;

const BACKGROUND_GRACE_MS = 30_000;

export interface RnChatOptions extends ChatOptions {
  /** Keep the socket this long after the app goes to the background (default 30 s). */
  backgroundGraceMs?: number;
}

/**
 * Chat for React Native: disconnects 30 s after the app backgrounds, reconnects + syncs on foreground,
 * reconnects immediately when NetInfo reports connectivity again (if installed). The AppState and NetInfo
 * listeners live from connect() to disconnect(), so signing out and in again leaves none behind.
 */
export function createChat(opts: RnChatOptions): Chat {
  const chat = new Chat({ sdkName: "react-native", ...opts });
  let bgTimer: ReturnType<typeof setTimeout> | null = null;
  let detach: (() => void) | null = null;
  const connect = chat.connect.bind(chat);
  const disconnect = chat.disconnect.bind(chat);

  const onAppState = (s: AppStateStatus) => {
    if (s === "active") {
      if (bgTimer) clearTimeout(bgTimer);
      bgTimer = null;
      if (chat.connectionState === "disconnected") void connect().catch(() => {});
      else chat.transport.reconnectNow();
    } else if (s === "background") {
      if (bgTimer) clearTimeout(bgTimer);
      bgTimer = setTimeout(() => void disconnect(), opts.backgroundGraceMs ?? BACKGROUND_GRACE_MS);
    }
  };

  function attach() {
    if (detach) return;
    const appState = AppState.addEventListener("change", onAppState);
    let netInfoOff: (() => void) | undefined;
    try {
      const NetInfo = require("@react-native-community/netinfo").default;
      netInfoOff = NetInfo.addEventListener((state: { isConnected: boolean | null }) => {
        if (state.isConnected) chat.transport.reconnectNow();
      });
    } catch {
      /* NetInfo not installed: rely on backoff */
    }
    detach = () => {
      appState.remove();
      netInfoOff?.();
      if (bgTimer) clearTimeout(bgTimer);
      bgTimer = null;
      detach = null;
    };
  }

  chat.connect = () => {
    attach();
    return connect();
  };
  chat.disconnect = () => {
    detach?.();
    return disconnect();
  };
  return chat;
}

/** The parts of a react-native-mmkv instance we use: v2/v3 have `delete`, v4 renamed it to `remove`. */
export interface MMKVLike {
  getString(key: string): string | undefined;
  set(key: string, value: string): void;
  delete?(key: string): unknown;
  remove?(key: string): unknown;
}

/**
 * Persistence with react-native-mmkv (synchronous, fast). Pass an instance id (default "byotalk") or your own
 * instance. Works with v2/v3 (`new MMKV()`) and v4 (`createMMKV()`).
 */
export function mmkvPersistence(idOrInstance: string | MMKVLike = "byotalk"): PersistenceAdapter {
  let store: MMKVLike;
  if (typeof idOrInstance === "string") {
    const mmkv = require("react-native-mmkv");
    store = typeof mmkv.createMMKV === "function" ? mmkv.createMMKV({ id: idOrInstance }) : new mmkv.MMKV({ id: idOrInstance });
  } else store = idOrInstance;
  return {
    get: async (k) => store.getString(k) ?? null,
    set: async (k, v) => store.set(k, v),
    delete: async (k) => void (store.remove ? store.remove(k) : store.delete!(k)),
  };
}

/** Persistence with @react-native-async-storage/async-storage. */
export function asyncStoragePersistence(): PersistenceAdapter {
  const AsyncStorage = require("@react-native-async-storage/async-storage").default;
  return {
    get: (k) => AsyncStorage.getItem(k),
    set: (k, v) => AsyncStorage.setItem(k, v),
    delete: (k) => AsyncStorage.removeItem(k),
  };
}

export * from "../core/index.js";
