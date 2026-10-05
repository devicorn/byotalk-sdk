// Calls for a Chat client: incoming-call events, starting and joining calls, call history (docs/09 §9).
import type { Chat } from "../core/chat.js";
import { ChatError } from "../core/errors.js";
import type { WebSocketCtor } from "../core/transport.js";
import type { Page, Unsubscribe } from "../core/types.js";
import { Emitter } from "../core/util.js";
import { Call, mediaError, type LocalTracks } from "./call.js";
import type { CallInfo, CallKind, CallOptions, MediaGrant } from "./types.js";

const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };

export class CallClient {
  readonly WS: WebSocketCtor;
  private calls = new Map<string, Call>();
  private emitter = new Emitter();
  private current: Call | null = null;

  constructor(
    readonly chat: Chat,
    readonly options: CallOptions = {},
  ) {
    const WS = options.WebSocket ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket;
    if (!WS) throw new ChatError({ code: "invalid_request", type: "invalid_request", message: "No WebSocket implementation available; pass options.WebSocket" });
    this.WS = WS;
    chat.transport.on("frame", (f: { t: string; d?: { call?: CallInfo } }) => {
      if (f.t === "call" && f.d?.call) this.onSnapshot(f.d.call);
    });
    // After every (re)connect: pick up calls that started ringing while we were offline.
    chat.transport.on("hello", () => void this.refresh().catch(() => {}));
    if (chat.transport.isOpen) void this.refresh().catch(() => {});
  }

  /** Internal: the signed-in user id. */
  get me(): string {
    return this.chat.userId ?? "";
  }

  /** The call with live media on this device, if any. */
  get active(): Call | null {
    return this.current;
  }

  /** A call this client knows about. */
  get(callId: string): Call | undefined {
    return this.calls.get(callId);
  }

  on(event: "incoming", cb: (call: Call) => void): Unsubscribe;
  on(event: "call", cb: (call: Call) => void): Unsubscribe;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (...a: any[]) => void): Unsubscribe {
    return this.emitter.on(event, cb);
  }

  /**
   * Starts a call in a conversation and rings the other members. Asks for the microphone (and camera for
   * video) first, so nobody is rung if permission is denied. If the conversation already has a live call,
   * you join it instead.
   */
  async start(conversationId: string, opts: { video?: boolean; metadata?: Record<string, unknown> } = {}): Promise<Call> {
    const kind: CallKind = opts.video ? "video" : "audio";
    const warnings: ChatError[] = [];
    const local = await this.acquire(kind === "video", (e) => warnings.push(e));
    let out: { call: CallInfo; created: boolean; media: MediaGrant | null };
    try {
      out = await this.rpc("call.start", "/v1/calls", { cid: conversationId, kind, metadata: opts.metadata }, { conversationId, kind, metadata: opts.metadata });
    } catch (err) {
      for (const t of Object.values(local)) t?.stop();
      throw err;
    }
    const call = new Call(this, out.call, "connecting", local);
    this.track(call);
    for (const e of warnings) call.warn(e);
    if (!out.media || out.call.status === "ended") {
      call.finish(); // e.g. ended at once because the other person is busy
      return call;
    }
    await this.takeOver(call);
    try {
      await call.connect(out.media);
    } catch (err) {
      await call.leave().catch(() => {});
      throw err;
    }
    return call;
  }

  /** Joins a live call you were not rung for (a group call already in progress). */
  async join(callId: string, opts: { video?: boolean } = {}): Promise<Call> {
    const info = await this.chat.rest.request<CallInfo>("GET", `/v1/calls/${encodeURIComponent(callId)}`);
    let call = this.calls.get(callId);
    if (!call || call.state === "ended") {
      call = new Call(this, info, "incoming");
      this.track(call);
    }
    await call.accept({ video: opts.video ?? info.kind === "video" });
    return call;
  }

  /** Calls you are part of that are ringing or in progress (from the server). */
  async live(): Promise<Call[]> {
    await this.refresh();
    return [...this.calls.values()].filter((c) => c.state !== "ended");
  }

  /** Call history, newest first; all your calls or one conversation's. */
  history(opts: { conversationId?: string; limit?: number; cursor?: string } = {}): Promise<Page<CallInfo>> {
    return this.chat.rest.request("GET", "/v1/calls", { query: { conversationId: opts.conversationId, limit: opts.limit, cursor: opts.cursor } });
  }

  // ------------------------------------------------------------------ internal

  private async refresh() {
    const page = await this.chat.rest.request<Page<CallInfo>>("GET", "/v1/calls", { query: { live: true, limit: 20 } });
    for (const info of page.data) this.onSnapshot(info);
    // Calls we thought were live but the server no longer lists ended while we were away.
    for (const c of this.calls.values()) {
      if (c.state !== "ended" && !page.data.some((i) => i.id === c.id)) {
        const info = await this.chat.rest.request<CallInfo>("GET", `/v1/calls/${c.id}`).catch(() => null);
        if (info) c.update(info);
      }
    }
  }

  private onSnapshot(info: CallInfo) {
    const known = this.calls.get(info.id);
    if (known) return known.update(info);
    const mine = info.participants.find((p) => p.userId === this.me);
    if (info.status === "ended" || mine?.state !== "ringing") return; // not ringing here: nothing to show
    const call = new Call(this, info, "incoming");
    this.track(call);
    this.emitter.emit("incoming", call);
  }

  private track(call: Call) {
    this.calls.set(call.id, call);
    // Forget finished calls after a while so the map does not grow forever.
    call.on("ended", () => setTimeout(() => this.calls.get(call.id) === call && this.calls.delete(call.id), 60_000));
    this.emitter.emit("call", call);
  }

  /** One call with media per device: answering or starting another call hangs up the current one. */
  async takeOver(call: Call) {
    const cur = this.current;
    this.current = call;
    if (cur && cur !== call && cur.state !== "ended") await cur.leave().catch(() => {});
  }

  release(call: Call) {
    if (this.current === call) this.current = null;
  }

  devices(): NonNullable<CallOptions["mediaDevices"]> {
    const md = this.options.mediaDevices ?? (globalThis as { navigator?: { mediaDevices?: MediaDevices } }).navigator?.mediaDevices;
    if (!md) throw new ChatError({ code: "unsupported", type: "invalid_request", message: "No mediaDevices here; pass options.mediaDevices (react-native-webrtc on React Native)" });
    return md;
  }

  /**
   * Microphone (required) and camera (optional: if it fails the call continues audio-only and `onWarning`
   * gets the error). One getUserMedia call, so browsers show one permission prompt.
   */
  async acquire(video: boolean, onWarning: (e: ChatError) => void): Promise<LocalTracks> {
    const md = this.devices();
    const v = this.options.video ?? {};
    const videoC = { width: { ideal: v.width ?? 1280 }, height: { ideal: v.height ?? 720 }, frameRate: { ideal: v.frameRate ?? 30 }, facingMode: "user" };
    if (video) {
      try {
        const s = await md.getUserMedia({ audio: AUDIO, video: videoC });
        return { mic: s.getAudioTracks()[0], camera: s.getVideoTracks()[0] };
      } catch (err) {
        onWarning(mediaError(err));
      }
    }
    try {
      const s = await md.getUserMedia({ audio: AUDIO });
      return { mic: s.getAudioTracks()[0] };
    } catch (err) {
      throw mediaError(err);
    }
  }

  /** Socket frame when connected, else the REST equivalent (both return the same body). */
  async rpc<T>(frame: string, path: string, d: Record<string, unknown>, restBody?: Record<string, unknown>): Promise<T> {
    if (this.chat.transport.isOpen) return this.chat.transport.request<T>(frame, d, 10_000);
    return this.chat.rest.request<T>("POST", path, restBody ? { body: restBody } : {});
  }
}
