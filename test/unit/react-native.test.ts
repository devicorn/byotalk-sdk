// byotalk/react-native with its peer dependencies faked: AppState, NetInfo and both react-native-mmkv shapes.
import Module from "node:module";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { appStateSubs, netInfoSubs, mmkv } = vi.hoisted(() => ({
  appStateSubs: new Set<(s: string) => void>(),
  netInfoSubs: new Set<(s: { isConnected: boolean }) => void>(),
  mmkv: {} as Record<string, unknown>, // filled per test with the v3 or v4 exports
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_: string, cb: (s: string) => void) => {
      appStateSubs.add(cb);
      return { remove: () => appStateSubs.delete(cb) };
    },
  },
}));
// The adapter loads optional peers with Metro-style require(), which vi.mock does not see: answer them in Node's loader.
const fakes: Record<string, unknown> = {
  "@react-native-community/netinfo": {
    default: {
      addEventListener: (cb: (s: { isConnected: boolean }) => void) => {
        netInfoSubs.add(cb);
        return () => netInfoSubs.delete(cb);
      },
    },
  },
  "react-native-mmkv": mmkv,
};
const M = Module as unknown as { _load: (id: string, ...rest: unknown[]) => unknown };
const load = M._load;
M._load = (id, ...rest) => (id in fakes ? fakes[id] : load(id, ...rest));
afterAll(() => void (M._load = load));

const { createChat, mmkvPersistence } = await import("../../src/react-native/index.js");

class FakeMMKV {
  data = new Map<string, string>();
  getString = (k: string) => this.data.get(k);
  set = (k: string, v: string) => void this.data.set(k, v);
}

describe("react-native", () => {
  afterEach(() => {
    for (const k of Object.keys(mmkv)) delete mmkv[k];
  });

  it("mmkvPersistence works with react-native-mmkv v3 (new MMKV, delete)", async () => {
    const made: string[] = [];
    class MMKV extends FakeMMKV {
      constructor(o: { id: string }) {
        super();
        made.push(o.id);
      }
      delete = (k: string) => void this.data.delete(k);
    }
    mmkv.MMKV = MMKV;
    const p = mmkvPersistence("chat");
    await p.set("a", "1");
    expect(await p.get("a")).toBe("1");
    await p.delete("a");
    expect(await p.get("a")).toBeNull();
    expect(made).toEqual(["chat"]);
  });

  it("mmkvPersistence works with react-native-mmkv v4 (createMMKV, remove)", async () => {
    const store = Object.assign(new FakeMMKV(), { remove: vi.fn((k: string) => store.data.delete(k)) });
    const createMMKV = vi.fn(() => store);
    mmkv.createMMKV = createMMKV;
    const p = mmkvPersistence();
    await p.set("a", "1");
    await p.delete("a");
    expect(await p.get("a")).toBeNull();
    expect(createMMKV).toHaveBeenCalledWith({ id: "byotalk" });
    expect(store.remove).toHaveBeenCalledWith("a");
  });

  it("mmkvPersistence accepts an instance", async () => {
    const store = Object.assign(new FakeMMKV(), { remove: (k: string) => store.data.delete(k) });
    const p = mmkvPersistence(store);
    await p.set("k", "v");
    expect(store.data.get("k")).toBe("v");
  });

  describe("createChat listeners", () => {
    class WS {
      readyState = 0;
      close() {}
    }
    beforeEach(() => {
      appStateSubs.clear();
      netInfoSubs.clear();
    });

    it("adds AppState and NetInfo listeners on connect and removes them on disconnect, every time", async () => {
      const chat = createChat({ env: "env_1", token: "dev:alice", WebSocket: WS as never });
      expect(appStateSubs.size + netInfoSubs.size).toBe(0);
      for (let i = 0; i < 3; i++) {
        void chat.connect().catch(() => {});
        void chat.connect().catch(() => {}); // a second connect adds nothing
        expect([appStateSubs.size, netInfoSubs.size]).toEqual([1, 1]);
        await chat.disconnect();
        expect([appStateSubs.size, netInfoSubs.size]).toEqual([0, 0]);
      }
    });
  });
});
