// byotalk/calls against a running byotalk-server (api + gateway + media). mediasoup-client's FakeHandler
// replaces the browser's WebRTC stack here; real audio/video is covered by test/browser/calls.spec.ts.
import { FakeMediaStreamTrack } from "fake-mediastreamtrack";
import * as fakeParameters from "mediasoup-client/fakeParameters";
import { FakeHandler } from "mediasoup-client/handlers/FakeHandler";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Call, CallClient, type CallOptions } from "../../src/calls/index.js";
import { Chat } from "../../src/core/index.js";
import { createDevEnv } from "./setup.js";

const API = process.env.BYOTALK_API_URL ?? "http://localhost:3000";
const RT = process.env.BYOTALK_RT_URL ?? "ws://localhost:3001";

let env: string;
const chats: Chat[] = [];

const stream = (kinds: ("audio" | "video")[]) => {
  const tracks = kinds.map((kind) => new FakeMediaStreamTrack({ kind }) as unknown as MediaStreamTrack);
  return { getAudioTracks: () => tracks.filter((t) => t.kind === "audio"), getVideoTracks: () => tracks.filter((t) => t.kind === "video") } as MediaStream;
};

function fakeDevices(opts: { denyCamera?: boolean; denyAll?: boolean } = {}): CallOptions["mediaDevices"] {
  return {
    getUserMedia: async (c?: MediaStreamConstraints) => {
      if (opts.denyAll || (opts.denyCamera && c?.video)) throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
      return stream([...(c?.audio ? ["audio" as const] : []), ...(c?.video ? ["video" as const] : [])]);
    },
    getDisplayMedia: async () => stream(["video"]),
    enumerateDevices: async () => [],
  };
}

async function client(user: string, devices = fakeDevices()) {
  const chat = new Chat({ env, token: Chat.devToken(user), baseUrl: API, realtimeUrl: RT });
  chats.push(chat);
  await chat.connect();
  return new CallClient(chat, { device: { handlerFactory: FakeHandler.createFactory(fakeParameters) }, mediaDevices: devices });
}

function waitFor<T>(fn: () => T | undefined | false | null, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const end = Date.now() + ms;
    const tick = () => {
      const v = fn();
      if (v) return resolve(v);
      if (Date.now() > end) return reject(new Error(`timeout waiting for ${fn.toString().slice(0, 120)}`));
      setTimeout(tick, 25);
    };
    tick();
  });
}

const nextIncoming = (c: CallClient) => new Promise<Call>((resolve) => { const off = c.on("incoming", (call) => (off(), resolve(call))); });
const peer = (call: Call, userId: string) => call.participants.find((p) => p.userId === userId)!;

beforeAll(async () => {
  env = await createDevEnv(API);
});
afterAll(async () => {
  for (const c of chats) await c.disconnect();
});

describe("calls SDK", () => {
  it("one-to-one video call: ring, accept, remote tracks, mute, screen share, hang up", async () => {
    const alice = await client("alice");
    const bob = await client("bob");
    const conv = await alice.chat.conversations.direct("bob");
    const ringing = nextIncoming(bob);
    const call = await alice.start(conv.id, { video: true });
    expect(call.direction).toBe("outgoing");
    expect(call.localMedia).toMatchObject({ micEnabled: true, cameraEnabled: true });

    const incoming = await ringing;
    expect(incoming).toMatchObject({ state: "incoming", kind: "video", conversationId: conv.id, direction: "incoming" });
    await incoming.accept();
    expect(bob.active).toBe(incoming);

    // Each side receives the other's microphone and camera.
    await waitFor(() => peer(incoming, "alice").audioTrack && peer(incoming, "alice").videoTrack);
    await waitFor(() => peer(call, "bob").audioTrack && peer(call, "bob").videoTrack);
    expect(peer(incoming, "alice")).toMatchObject({ inCall: true, audioMuted: false, videoMuted: false, isLocal: false });

    await call.setMicrophoneEnabled(false);
    await waitFor(() => peer(incoming, "alice").audioMuted);
    await call.setMicrophoneEnabled(true);
    await waitFor(() => !peer(incoming, "alice").audioMuted);
    await call.setCameraEnabled(false);
    await waitFor(() => peer(incoming, "alice").videoMuted);
    expect(call.localMedia.cameraEnabled).toBe(false);
    await call.setCameraEnabled(true);
    await waitFor(() => !peer(incoming, "alice").videoMuted);

    await incoming.startScreenShare();
    await waitFor(() => peer(call, "bob").screenTrack);
    await incoming.stopScreenShare();
    await waitFor(() => !peer(call, "bob").screenTrack);

    await incoming.setVideoQuality("alice", "off");
    await incoming.setVideoQuality("alice", "low");

    const ended = new Promise((r) => call.on("ended", r));
    await incoming.leave();
    await ended;
    expect(call.state).toBe("ended");
    // FakeHandler never completes DTLS, so the server never sees media flow ("completed" is asserted in the browser E2E).
    await waitFor(() => call.info.status === "ended");
    expect(alice.active).toBeNull();
  });

  it("decline, and answered on another device stops ringing here", async () => {
    const carol = await client("carol");
    const dan1 = await client("dan");
    const dan2 = await client("dan");
    const conv = await carol.chat.conversations.direct("dan");

    let r1 = nextIncoming(dan1);
    let r2 = nextIncoming(dan2);
    const c1 = await carol.start(conv.id);
    const [d1, d2] = await Promise.all([r1, r2]);
    const endedOn2 = new Promise((r) => d2.on("ended", r));
    await d1.accept();
    await endedOn2;
    expect(d2.endedHere).toBe("answered_elsewhere");
    await c1.leave();

    r1 = nextIncoming(dan1);
    r2 = nextIncoming(dan2);
    const c2 = await carol.start(conv.id);
    const [e1] = await Promise.all([r1, r2]);
    const callerEnded = new Promise((r) => c2.on("ended", r));
    await e1.decline();
    await callerEnded;
    await waitFor(() => c2.info.endReason === "declined");
  });

  it("camera denied → audio-only with a warning; microphone denied → nobody is rung", async () => {
    const erin = await client("erin", fakeDevices({ denyCamera: true }));
    await client("frank");
    const conv = await erin.chat.conversations.direct("frank");
    const call = await erin.start(conv.id, { video: true });
    const warn = await new Promise<{ code: string }>((r) => call.on("error", r));
    expect(warn.code).toBe("media_permission_denied");
    expect(call.localMedia).toMatchObject({ micEnabled: true, cameraEnabled: false });
    await call.leave();

    const mute = await client("gina", fakeDevices({ denyAll: true }));
    const conv2 = await mute.chat.conversations.direct("frank");
    await expect(mute.start(conv2.id)).rejects.toMatchObject({ code: "media_permission_denied" });
    expect((await mute.history({ conversationId: conv2.id })).data).toHaveLength(0);
  });

  it("group call with late join and history", async () => {
    const [h, i, j] = await Promise.all([client("hal"), client("ida"), client("jon")]);
    const conv = await h.chat.conversations.create({ name: "Team", members: ["ida", "jon"] });
    const ri = nextIncoming(i);
    const call = await h.start(conv.id);
    await (await ri).accept();
    await waitFor(() => call.participants.filter((p) => p.inCall && !p.isLocal).length === 1);
    // jon ignores the ring, then joins the running call from the conversation screen.
    const jc = await j.join(call.id);
    await waitFor(() => call.participants.filter((p) => p.inCall && !p.isLocal).length === 2);
    expect(jc.participants.filter((p) => p.audioTrack && !p.isLocal)).toHaveLength(2);
    await Promise.all([call.leave(), jc.leave(), i.active!.leave()]);
    const hist = await h.history({ conversationId: conv.id });
    expect(hist.data[0]).toMatchObject({ id: call.id, status: "ended" });
  });

  it("recovers when the media connection drops (new session, same seat)", async () => {
    const kim = await client("kim");
    const leo = await client("leo");
    const conv = await kim.chat.conversations.direct("leo");
    const r = nextIncoming(leo);
    const call = await kim.start(conv.id);
    const other = await r;
    await other.accept();
    await waitFor(() => peer(call, "leo").audioTrack);
    const states: string[] = [];
    call.on("state", (s) => states.push(s));
    // Simulate a network drop of the signaling socket.
    (call as unknown as { sig: { ws: WebSocket } }).sig.ws.close(4999, "test");
    await waitFor(() => states.includes("reconnecting"));
    await waitFor(() => peer(call, "leo").audioTrack && peer(other, "kim").audioTrack, 8000);
    expect(call.state).not.toBe("ended");
    await call.leave();
  });

  it("an incoming call that rang while offline shows up after reconnecting", async () => {
    const mia = await client("mia");
    const ned = await client("ned");
    const conv = await mia.chat.conversations.direct("ned");
    await ned.chat.disconnect();
    const call = await mia.start(conv.id);
    const ringing = nextIncoming(ned);
    await ned.chat.connect();
    expect((await ringing).id).toBe(call.id);
    await call.leave();
  });
});
