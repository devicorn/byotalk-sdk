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
 * reconnects immediately when NetInfo reports connectivity again (if installed).
 */
export function createChat(opts: RnChatOptions): Chat {
  const chat = new Chat({ sdkName: "react-native", ...opts });
  let bgTimer: ReturnType<typeof setTimeout> | null = null;
  let wantConnected = false;
  const connect = chat.connect.bind(chat);
  const disconnect = chat.disconnect.bind(chat);
  chat.connect = () => {
    wantConnected = true;
    return connect();
  };
  chat.disconnect = () => {
    wantConnected = false;
    return disconnect();
  };

  AppState.addEventListener("change", (s: AppStateStatus) => {
    if (s === "active") {
      if (bgTimer) clearTimeout(bgTimer);
      bgTimer = null;
      if (wantConnected) {
        if (chat.connectionState === "disconnected") void connect().catch(() => {});
        else chat.transport.reconnectNow();
      }
    } else if (s === "background") {
      if (bgTimer) clearTimeout(bgTimer);
      bgTimer = setTimeout(() => void disconnect(), opts.backgroundGraceMs ?? BACKGROUND_GRACE_MS);
    }
  });

  try {
    const NetInfo = require("@react-native-community/netinfo").default;
    NetInfo.addEventListener((state: { isConnected: boolean | null }) => {
      if (state.isConnected && wantConnected) chat.transport.reconnectNow();
    });
  } catch {
    /* NetInfo not installed: rely on backoff */
  }
  return chat;
}

/** Persistence with react-native-mmkv (synchronous, fast). */
export function mmkvPersistence(id = "byotalk"): PersistenceAdapter {
  const { MMKV } = require("react-native-mmkv");
  const store = new MMKV({ id });
  return {
    get: async (k) => store.getString(k) ?? null,
    set: async (k, v) => store.set(k, v),
    delete: async (k) => store.delete(k),
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
