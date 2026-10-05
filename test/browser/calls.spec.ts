// Real WebRTC end to end: Chromium with fake camera/microphone, the real media server (mediasoup), and coturn.
// Asserts that decoded video frames and audio bytes actually arrive, not just that signaling succeeded.
import { expect, test, type Browser, type Page } from "@playwright/test";
import { createDevEnv } from "../integration/setup.js";

const API = process.env.BYOTALK_API_URL ?? "http://localhost:3000";
const RT = process.env.BYOTALK_RT_URL ?? "ws://localhost:3001";

let env: string;

test.beforeAll(async () => {
  env = await createDevEnv(API, "Browser call tests");
});

/** One user = one browser context (own devices, own sockets). */
async function user(browser: Browser, userId: string, opts: { relay?: boolean } = {}): Promise<Page> {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.log(`[${userId}] pageerror`, e.message));
  await page.goto("/");
  await page.waitForFunction(() => "byotalk" in window);
  await page.evaluate(
    async ({ env, userId, API, RT, relay }) => {
      const { Chat, CallClient } = (window as any).byotalk;
      const chat = new Chat({ env, token: Chat.devToken(userId), baseUrl: API, realtimeUrl: RT });
      await chat.connect();
      const calls = new CallClient(chat, relay ? { iceTransportPolicy: "relay" } : {});
      const w = window as any;
      w.chat = chat;
      w.calls = calls;
      w.incoming = [];
      calls.on("incoming", (c: unknown) => w.incoming.push(c));
    },
    { env, userId, API, RT, relay: !!opts.relay },
  );
  return page;
}

const startCall = (page: Page, peers: string[], video = true) =>
  page.evaluate(
    async ({ peers, video }) => {
      const w = window as any;
      const conv = peers.length === 1 ? await w.chat.conversations.direct(peers[0]) : await w.chat.conversations.create({ name: "Group", members: peers });
      w.call = await w.calls.start(conv.id, { video });
      return w.call.id as string;
    },
    { peers, video },
  );

const accept = async (page: Page) => {
  await page.waitForFunction(() => (window as any).incoming.length > 0, null, { timeout: 10_000 });
  await page.evaluate(async () => {
    const w = window as any;
    w.call = w.incoming.at(-1);
    await w.call.accept();
  });
};

const waitConnected = (page: Page) => page.waitForFunction(() => (window as any).call?.state === "connected", null, { timeout: 15_000 });

/** Renders every remote video track and waits until each has decoded frames with a real size. */
async function remoteVideos(page: Page, count: number) {
  await page.waitForFunction((n) => (window as any).call.participants.filter((p: any) => !p.isLocal && p.videoTrack).length >= n, count, { timeout: 15_000 });
  return page.evaluate(async (n) => {
    const tracks = (window as any).call.participants.filter((p: any) => !p.isLocal && p.videoTrack).map((p: any) => p.videoTrack as MediaStreamTrack);
    const sizes = await Promise.all(
      tracks.slice(0, n).map(
        (t: MediaStreamTrack) =>
          new Promise<{ w: number; h: number }>((resolve, reject) => {
            const v = document.createElement("video");
            v.muted = true;
            v.autoplay = true;
            v.srcObject = new MediaStream([t]);
            document.body.append(v);
            const timer = setTimeout(() => reject(new Error("no video frames")), 10_000);
            const check = () => (v.videoWidth > 0 ? (clearTimeout(timer), resolve({ w: v.videoWidth, h: v.videoHeight })) : requestAnimationFrame(check));
            void v.play().catch(() => {});
            check();
          }),
      ),
    );
    return sizes;
  }, count);
}

/** Inbound RTP bytes by kind, measured twice 1.5 s apart: media must keep flowing. */
async function flowing(page: Page) {
  const sample = () =>
    page.evaluate(async () => {
      const call = (window as any).call;
      const recv = call.recvT as { getStats(): Promise<RTCStatsReport> };
      const out = { audio: 0, video: 0 };
      (await recv.getStats()).forEach((r: any) => {
        if (r.type === "inbound-rtp") out[r.kind as "audio" | "video"] += r.bytesReceived ?? 0;
      });
      return out;
    });
  const a = await sample();
  await page.waitForTimeout(1500);
  const b = await sample();
  return { audio: b.audio - a.audio, video: b.video - a.video };
}

const serverCall = async (id: string) => (await (await fetch(`${API}/v1/calls/${id}?env=${env}`, { headers: { authorization: "Bearer dev:alice" } })).json()) as any;

test("1:1 video call: real audio and video both ways, mute, camera off, hang up", async ({ browser }) => {
  const alice = await user(browser, "alice");
  const bob = await user(browser, "bob");
  const id = await startCall(alice, ["bob"]);
  await accept(bob);
  await Promise.all([waitConnected(alice), waitConnected(bob)]);

  expect((await remoteVideos(alice, 1))[0]!.w).toBeGreaterThan(0);
  expect((await remoteVideos(bob, 1))[0]!.w).toBeGreaterThan(0);
  const f = await flowing(bob);
  expect(f.audio).toBeGreaterThan(1000);
  expect(f.video).toBeGreaterThan(10_000);

  // The server saw media connect on both sides → active.
  await expect.poll(async () => (await serverCall(id)).status, { timeout: 10_000 }).toBe("active");
  const stats = await alice.evaluate(() => (window as any).call.getStats());
  expect(stats.rttMs).not.toBeNull();
  // Locally the media server announces 127.0.0.1, which Chrome cannot reach from its LAN candidates, so the
  // TURN fallback carries the media; on a VPS with a public IP it is "host"/"srflx".
  expect(stats.candidateType).toMatch(/^(host|srflx|prflx|relay)$/);

  await alice.evaluate(() => (window as any).call.setMicrophoneEnabled(false));
  await bob.waitForFunction(() => (window as any).call.participants.find((p: any) => p.userId === "alice").audioMuted);
  await alice.evaluate(() => (window as any).call.setCameraEnabled(false));
  await bob.waitForFunction(() => (window as any).call.participants.find((p: any) => p.userId === "alice").videoMuted);
  await alice.evaluate(() => (window as any).call.setCameraEnabled(true));
  await bob.waitForFunction(() => !(window as any).call.participants.find((p: any) => p.userId === "alice").videoMuted);
  expect((await remoteVideos(bob, 1))[0]!.w).toBeGreaterThan(0);

  await bob.waitForTimeout(1000);
  await bob.evaluate(() => (window as any).call.leave());
  await alice.waitForFunction(() => (window as any).call.state === "ended");
  const done = await serverCall(id);
  expect(done).toMatchObject({ status: "ended", endReason: "completed" });
  expect(done.durationSeconds).toBeGreaterThanOrEqual(1);
  // Camera and microphone are released after the call.
  expect(await alice.evaluate(() => (window as any).call.localMedia.audioTrack)).toBeNull();
});

test("TURN relay only (restrictive network): media flows through coturn", async ({ browser }) => {
  const carol = await user(browser, "carol", { relay: true });
  const dan = await user(browser, "dan", { relay: true });
  await startCall(carol, ["dan"]);
  await accept(dan);
  await Promise.all([waitConnected(carol), waitConnected(dan)]);
  expect((await carol.evaluate(() => (window as any).call.getStats())).candidateType).toBe("relay");
  expect((await remoteVideos(dan, 1))[0]!.w).toBeGreaterThan(0);
  expect((await flowing(carol)).audio).toBeGreaterThan(1000);
  await carol.evaluate(() => (window as any).call.leave());
});

test("group call: three people each receive the other two", async ({ browser }) => {
  const [h, i, j] = await Promise.all([user(browser, "hal"), user(browser, "ida"), user(browser, "jon")]);
  await startCall(h, ["ida", "jon"]);
  await Promise.all([accept(i), accept(j)]);
  await Promise.all([waitConnected(h), waitConnected(i), waitConnected(j)]);
  for (const p of [h, i, j]) expect(await remoteVideos(p, 2)).toHaveLength(2);
  // Active speaker / audio levels arrive from the server for the fake tone.
  await h.waitForFunction(() => (window as any).call.participants.some((p: any) => !p.isLocal && p.audioLevel > 0), null, { timeout: 10_000 });
  // Screen share reaches the others.
  await i.evaluate(() => (window as any).call.startScreenShare());
  await h.waitForFunction(() => (window as any).call.participants.find((p: any) => p.userId === "ida").screenTrack, null, { timeout: 10_000 });
  await i.evaluate(() => (window as any).call.stopScreenShare());
  await h.waitForFunction(() => !(window as any).call.participants.find((p: any) => p.userId === "ida").screenTrack);
  for (const p of [h, i, j]) await p.evaluate(() => (window as any).call.leave());
});

test("signaling drop: the call reconnects and media flows again", async ({ browser }) => {
  const kim = await user(browser, "kim");
  const leo = await user(browser, "leo");
  await startCall(kim, ["leo"]);
  await accept(leo);
  await Promise.all([waitConnected(kim), waitConnected(leo)]);
  await remoteVideos(leo, 1);
  const videoId = () => (window as any).call.participants.find((p: any) => !p.isLocal && p.videoTrack)?.videoTrack.id ?? null;
  const before = await leo.evaluate(videoId);
  await kim.evaluate(() => (window as any).call.sig.ws.close(4999, "test drop"));
  await kim.waitForFunction(() => (window as any).call.state === "reconnecting");
  await waitConnected(kim);
  // kim rejoined with a new session: leo's old track of kim goes away and a new one arrives.
  await leo.waitForFunction(
    (old) => {
      const id = (window as any).call.participants.find((p: any) => !p.isLocal && p.videoTrack)?.videoTrack.id;
      return id && id !== old;
    },
    before,
    { timeout: 15_000 },
  );
  expect((await remoteVideos(kim, 1))[0]!.w).toBeGreaterThan(0);
  expect((await remoteVideos(leo, 1))[0]!.w).toBeGreaterThan(0);
  expect((await flowing(leo)).audio).toBeGreaterThan(1000);
  await kim.evaluate(() => (window as any).call.leave());
});
