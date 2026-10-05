// One call on this device: local media, the SFU session (mediasoup-client), remote tracks, reconnection.
// docs/19-CALLS.md §5 describes the call.v1 protocol this speaks.
import { Device, type types as ms } from "mediasoup-client";
import { ChatError } from "../core/errors.js";
import type { Unsubscribe } from "../core/types.js";
import { backoffDelay, Emitter, sleep } from "../core/util.js";
import type { CallClient } from "./client.js";
import { Signaling } from "./signaling.js";
import type { CallInfo, CallState, CallStats, MediaGrant, NetworkQuality, Participant, TrackSource, VideoQuality } from "./types.js";

/** Three simulcast layers: receivers get the best one their bandwidth (and tile size) allows. */
const CAMERA_ENCODINGS: RTCRtpEncodingParameters[] = [
  { scaleResolutionDownBy: 4, maxBitrate: 150_000 },
  { scaleResolutionDownBy: 2, maxBitrate: 500_000 },
  { scaleResolutionDownBy: 1, maxBitrate: 1_500_000 },
];
const SCREEN_ENCODINGS: RTCRtpEncodingParameters[] = [{ maxBitrate: 2_500_000 }];
const AUDIO = { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
const LAYER: Record<Exclude<VideoQuality, "off">, number> = { low: 0, medium: 1, high: 2 };
const RECONNECT_GIVE_UP_MS = 60_000;
const FATAL = new Set(["call_ended", "not_found", "forbidden", "plan_limit_reached", "token_invalid"]);

interface RemoteTrack {
  consumer: ms.Consumer;
  source: TrackSource;
  paused: boolean;
}

interface Remote {
  inCall: boolean;
  tracks: Map<string, RemoteTrack>;
}

export type LocalTracks = Partial<Record<TrackSource, MediaStreamTrack>>;

export function mediaError(err: unknown): ChatError {
  const name = (err as { name?: string })?.name;
  if (name === "NotAllowedError" || name === "SecurityError") return new ChatError({ code: "media_permission_denied", type: "permission", message: "Microphone or camera permission was denied" });
  if (name === "NotFoundError" || name === "OverconstrainedError") return new ChatError({ code: "media_device_not_found", type: "invalid_request", message: "No microphone or camera was found" });
  if (name === "NotReadableError") return new ChatError({ code: "media_device_busy", type: "unavailable", message: "The microphone or camera is in use by another app" });
  return new ChatError({ code: "media_error", message: (err as Error)?.message ?? "Could not open the microphone or camera" });
}

export class Call {
  /** Server view; updated by events. */
  info: CallInfo;
  state: CallState;
  /** Set when the call ended on this device because it was answered or declined on another one. */
  endedHere: "answered_elsewhere" | "declined_elsewhere" | "replaced" | null = null;
  activeSpeaker: string | null = null;
  quality: NetworkQuality = "unknown";

  private emitter = new Emitter();
  private warnings: ChatError[] = [];
  private sig: Signaling | null = null;
  private device: ms.Device | null = null;
  private sendT: ms.Transport | null = null;
  private recvT: ms.Transport | null = null;
  private gen = 0;
  private reconnecting = false;
  private local: LocalTracks = {};
  private producers = new Map<TrackSource, ms.Producer>();
  private mutedSources = new Set<TrackSource>();
  private remotes = new Map<string, Remote>();
  private levels = new Map<string, number>();
  private videoPrefs = new Map<string, VideoQuality>();
  private iceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private statsTimer: ReturnType<typeof setInterval> | null = null;
  private lastInbound = { lost: 0, received: 0 };
  private lossAvg = 0;
  private detachOnline: (() => void) | null = null;
  private facingMode: "user" | "environment" = "user";

  constructor(
    private readonly client: CallClient,
    info: CallInfo,
    state: CallState,
    local: LocalTracks = {},
  ) {
    this.info = info;
    this.state = state;
    this.local = local;
  }

  get id() {
    return this.info.id;
  }
  get conversationId() {
    return this.info.conversationId;
  }
  get kind() {
    return this.info.kind;
  }
  /** Server status: ringing until a second person connects, then active, then ended. */
  get status() {
    return this.info.status;
  }
  get direction(): "outgoing" | "incoming" {
    return this.info.createdBy === this.client.me ? "outgoing" : "incoming";
  }

  on(event: "state", cb: (s: CallState) => void): Unsubscribe;
  on(event: "participants", cb: (p: Participant[]) => void): Unsubscribe;
  on(event: "updated", cb: (info: CallInfo) => void): Unsubscribe;
  on(event: "activeSpeaker", cb: (userId: string | null) => void): Unsubscribe;
  on(event: "quality", cb: (q: NetworkQuality, stats: CallStats) => void): Unsubscribe;
  on(event: "local", cb: () => void): Unsubscribe;
  on(event: "forceMute", cb: (source: "mic" | "camera" | "screen") => void): Unsubscribe;
  on(event: "ended", cb: (info: CallInfo) => void): Unsubscribe;
  on(event: "error", cb: (e: ChatError) => void): Unsubscribe;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, cb: (...a: any[]) => void): Unsubscribe {
    const off = this.emitter.on(event, cb);
    // Warnings raised before anyone listened (e.g. camera denied during start()) go to the first listener.
    if (event === "error") for (const e of this.warnings.splice(0)) setTimeout(() => cb(e));
    return off;
  }

  // ------------------------------------------------------------------ state views

  /** This device's own media. */
  get localMedia() {
    return {
      audioTrack: this.local.mic ?? null,
      videoTrack: this.local.camera ?? null,
      screenTrack: this.local.screen ?? null,
      micEnabled: !!this.local.mic && !this.mutedSources.has("mic"),
      cameraEnabled: !!this.local.camera && !this.mutedSources.has("camera"),
      screenSharing: !!this.local.screen,
    };
  }

  /** Everyone invited, local user first, then in invitation order. */
  get participants(): Participant[] {
    const me = this.client.me;
    const ids = [...new Set([me, ...this.info.participants.map((p) => p.userId), ...this.remotes.keys()])];
    return ids.map((userId) => {
      const server = this.info.participants.find((p) => p.userId === userId);
      const level = this.levels.get(userId) ?? 0;
      if (userId === me) {
        const lm = this.localMedia;
        return {
          userId,
          isLocal: true,
          state: server?.state ?? "joining",
          inCall: this.state === "connected" || this.state === "reconnecting",
          audioTrack: lm.audioTrack,
          videoTrack: lm.cameraEnabled ? lm.videoTrack : null,
          screenTrack: lm.screenTrack,
          screenAudioTrack: this.local["screen-audio"] ?? null,
          audioMuted: !lm.micEnabled,
          videoMuted: !lm.cameraEnabled,
          speaking: level > 0,
          audioLevel: level,
        };
      }
      const r = this.remotes.get(userId);
      const track = (s: TrackSource) => [...(r?.tracks.values() ?? [])].find((t) => t.source === s);
      const mic = track("mic");
      const cam = track("camera");
      return {
        userId,
        isLocal: false,
        state: server?.state ?? "joined",
        inCall: !!r?.inCall,
        audioTrack: mic?.consumer.track ?? null,
        videoTrack: cam && !cam.paused ? cam.consumer.track : null,
        screenTrack: track("screen")?.consumer.track ?? null,
        screenAudioTrack: track("screen-audio")?.consumer.track ?? null,
        audioMuted: !mic || mic.paused,
        videoMuted: !cam || cam.paused,
        speaking: level > 0,
        audioLevel: level,
      };
    });
  }

  // ------------------------------------------------------------------ user actions

  /** Answers an incoming call (asks for the microphone, and the camera for video calls unless video: false). */
  async accept(opts: { video?: boolean } = {}): Promise<void> {
    if (this.state !== "incoming") throw new ChatError({ code: "invalid_request", type: "invalid_request", message: `Cannot accept a call in state ${this.state}` });
    await this.client.takeOver(this);
    this.setState("connecting");
    try {
      this.local = await this.client.acquire(opts.video ?? this.kind === "video", (e) => this.emitter.emit("error", e));
      const { call, media } = await this.client.rpc<{ call: CallInfo; media: MediaGrant }>("call.join", `/v1/calls/${this.id}/join`, { callId: this.id });
      this.update(call);
      await this.connect(media);
    } catch (err) {
      this.stopLocal();
      if ((this.state as CallState) === "connecting") this.setState("incoming");
      this.client.release(this);
      throw err;
    }
  }

  async decline(): Promise<void> {
    const r = await this.client.rpc<{ call: CallInfo }>("call.decline", `/v1/calls/${this.id}/decline`, { callId: this.id });
    this.update(r.call);
    this.finish();
  }

  /** Hangs up. In a one-to-one call this ends the call for both. */
  async leave(): Promise<void> {
    if (this.state === "ended") return;
    this.finish();
    try {
      const r = await this.client.rpc<{ call: CallInfo }>("call.leave", `/v1/calls/${this.id}/leave`, { callId: this.id });
      this.info = r.call;
      this.emitter.emit("updated", this.info);
    } catch (err) {
      // The media server frees the seat after its reconnect grace even if this request is lost.
      if (!(err instanceof ChatError && err.code === "call_ended")) this.emitter.emit("error", err);
    }
  }

  async setMicrophoneEnabled(on: boolean): Promise<void> {
    if (on && !this.local.mic) {
      this.local.mic = await this.userTrack("audio");
      await this.produce("mic");
    }
    await this.setPaused("mic", !on);
  }

  /** Turning the camera off releases it (the light goes off); turning it on in an audio call upgrades to video. */
  async setCameraEnabled(on: boolean): Promise<void> {
    if (!on) {
      await this.setPaused("camera", true);
      this.local.camera?.stop();
      this.emitLocal();
      return;
    }
    const track = await this.userTrack("video");
    const old = this.local.camera;
    this.local.camera = track;
    const p = this.producers.get("camera");
    if (p) await p.replaceTrack({ track });
    else await this.produce("camera");
    if (old && old !== track) old.stop();
    await this.setPaused("camera", false);
  }

  /** Front/back camera on phones; the next camera on desktops. */
  async switchCamera(): Promise<void> {
    const devices = (await this.client.devices().enumerateDevices?.())?.filter((d) => d.kind === "videoinput") ?? [];
    const current = this.local.camera?.getSettings().deviceId;
    const next = devices.length > 1 ? devices[(devices.findIndex((d) => d.deviceId === current) + 1) % devices.length] : undefined;
    this.facingMode = this.facingMode === "user" ? "environment" : "user";
    await this.replaceInput("camera", next ? { deviceId: { exact: next.deviceId } } : { facingMode: this.facingMode });
  }

  setAudioInput(deviceId: string): Promise<void> {
    return this.replaceInput("mic", { deviceId: { exact: deviceId } });
  }

  setVideoInput(deviceId: string): Promise<void> {
    return this.replaceInput("camera", { deviceId: { exact: deviceId } });
  }

  async startScreenShare(opts: { audio?: boolean } = {}): Promise<void> {
    const md = this.client.devices();
    if (!md.getDisplayMedia) throw new ChatError({ code: "unsupported", type: "invalid_request", message: "Screen sharing is not available here" });
    let stream: MediaStream;
    try {
      stream = await md.getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: opts.audio ?? false });
    } catch (err) {
      throw mediaError(err);
    }
    await this.stopScreenShare();
    const video = stream.getVideoTracks()[0]!;
    if ("contentHint" in video) video.contentHint = "detail";
    video.addEventListener("ended", () => void this.stopScreenShare());
    this.local.screen = video;
    const audio = stream.getAudioTracks()[0];
    if (audio) this.local["screen-audio"] = audio;
    await this.produce("screen");
    if (audio) await this.produce("screen-audio");
    this.emitLocal();
  }

  async stopScreenShare(): Promise<void> {
    for (const s of ["screen", "screen-audio"] as const) {
      const p = this.producers.get(s);
      this.producers.delete(s);
      if (p) {
        p.close();
        await this.sig?.request("closeProducer", { producerId: p.id }).catch(() => {});
      }
      this.local[s]?.stop();
      delete this.local[s];
    }
    this.emitLocal();
  }

  /** Which camera layer to receive from `userId`: "off" pauses it (saves bandwidth for hidden tiles). */
  async setVideoQuality(userId: string, quality: VideoQuality): Promise<void> {
    this.videoPrefs.set(userId, quality);
    const t = [...(this.remotes.get(userId)?.tracks.values() ?? [])].find((x) => x.source === "camera");
    if (t) await this.applyPreference(t);
  }

  async getStats(): Promise<CallStats> {
    const stats: CallStats = { quality: "unknown", rttMs: null, availableOutgoingBitrate: null, packetLoss: null, bytesSent: 0, bytesReceived: 0, candidateType: null };
    let lost = 0;
    let received = 0;
    for (const t of [this.sendT, this.recvT]) {
      if (!t || t.closed) continue;
      const report = await t.getStats().catch(() => null);
      if (!report) continue;
      const byId = new Map<string, Record<string, unknown>>();
      report.forEach((r: Record<string, unknown>) => byId.set(r.id as string, r));
      // The transport report names the pair in use; older engines only flag it as nominated.
      const selectedId = [...byId.values()].find((r) => r.type === "transport" && r.selectedCandidatePairId)?.selectedCandidatePairId;
      for (const r of byId.values()) {
        if (r.type === "candidate-pair" && (selectedId ? r.id === selectedId : r.state === "succeeded" && (r.nominated || r.selected))) {
          if (typeof r.currentRoundTripTime === "number") stats.rttMs = Math.round(r.currentRoundTripTime * 1000);
          if (typeof r.availableOutgoingBitrate === "number" && t === this.sendT) stats.availableOutgoingBitrate = r.availableOutgoingBitrate;
          stats.candidateType ??= (byId.get(r.localCandidateId as string)?.candidateType as string) ?? null;
        }
        if (r.type === "outbound-rtp") stats.bytesSent += Number(r.bytesSent ?? 0);
        if (r.type === "inbound-rtp") {
          stats.bytesReceived += Number(r.bytesReceived ?? 0);
          lost += Number(r.packetsLost ?? 0);
          received += Number(r.packetsReceived ?? 0);
        }
      }
    }
    const dl = lost - this.lastInbound.lost;
    const dr = received - this.lastInbound.received;
    this.lastInbound = { lost, received };
    // Too few packets in the window say nothing (silence with DTX, a paused camera).
    stats.packetLoss = dl + dr >= 50 ? Math.max(0, dl) / (dl + dr) : null;
    // Smoothed, so one burst (a keyframe, a new screen share) does not flip the indicator.
    if (stats.packetLoss !== null) this.lossAvg = this.lossAvg * 0.6 + stats.packetLoss * 0.4;
    const rtt = stats.rttMs ?? 0;
    const loss = this.lossAvg;
    stats.quality = stats.rttMs === null ? "unknown" : rtt < 250 && loss < 0.02 ? "good" : rtt < 500 && loss < 0.08 ? "fair" : "poor";
    return stats;
  }

  /** Internal: report a non-fatal problem (e.g. the camera failed, the call continues audio-only). */
  warn(e: ChatError) {
    if (this.emitter.listenerCount("error")) this.emitter.emit("error", e);
    else this.warnings.push(e);
  }

  // ------------------------------------------------------------------ server snapshots (chat socket)

  /** Internal: a newer server snapshot of this call. */
  update(info: CallInfo) {
    this.info = info;
    const mine = info.participants.find((p) => p.userId === this.client.me);
    if (info.status === "ended") {
      this.finish();
    } else if (this.state === "incoming" && mine && mine.state !== "ringing") {
      // Answered or declined on another device of this user.
      this.endedHere = mine.state === "declined" ? "declined_elsewhere" : "answered_elsewhere";
      this.finish();
    }
    this.emitter.emit("updated", info);
    this.emitParticipants();
  }

  // ------------------------------------------------------------------ media session

  /** Internal: opens (or reopens) the media session with a fresh grant. */
  async connect(grant: MediaGrant): Promise<void> {
    const gen = ++this.gen;
    this.closeSession();
    const sig = new Signaling(
      this.client.WS,
      (t, d) => {
        if (gen !== this.gen) return;
        // A request racing a teardown fails harmlessly; anything else is worth reporting.
        this.onNotify(t, d).catch((err) => gen === this.gen && this.state !== "ended" && this.emitter.emit("error", err));
      },
      (code, info) => gen === this.gen && this.onSignalingClosed(code, info),
    );
    this.sig = sig;
    await sig.open(grant.url);
    const j = await sig.request<{ routerRtpCapabilities: ms.RtpCapabilities; peers: string[] }>("join", { token: grant.token });
    if (!this.device) {
      try {
        this.device = new Device(this.client.options.device);
      } catch (err) {
        throw new ChatError({ code: "unsupported", type: "invalid_request", message: `This browser cannot make calls: ${(err as Error).message}` });
      }
    }
    if (!this.device.loaded) await this.device.load({ routerRtpCapabilities: j.routerRtpCapabilities });
    this.sendT = await this.makeTransport(sig, grant, "send", gen);
    this.recvT = await this.makeTransport(sig, grant, "recv", gen);
    for (const u of j.peers) this.remote(u).inCall = true;
    await sig.request("ready", { rtpCapabilities: this.device.rtpCapabilities });
    for (const s of ["mic", "camera", "screen", "screen-audio"] as const) if (this.local[s]) await this.produce(s);
    this.watchNetwork();
    this.startStats();
    this.emitParticipants();
  }

  private async makeTransport(sig: Signaling, grant: MediaGrant, direction: "send" | "recv", gen: number) {
    const o = await sig.request<ms.TransportOptions>("createTransport", { direction });
    const opts: ms.TransportOptions = { ...o, iceServers: grant.iceServers, iceTransportPolicy: this.client.options.iceTransportPolicy ?? "all" };
    const t = direction === "send" ? this.device!.createSendTransport(opts) : this.device!.createRecvTransport(opts);
    t.on("connect", ({ dtlsParameters }, cb, eb) => void sig.request("connectTransport", { transportId: t.id, dtlsParameters }).then(() => cb(), eb));
    if (direction === "send") {
      t.on("produce", ({ kind, rtpParameters, appData }, cb, eb) =>
        void sig.request<{ id: string }>("produce", { transportId: t.id, kind, rtpParameters, source: appData.source, paused: appData.paused }).then((r) => cb({ id: r.id }), eb),
      );
    }
    t.on("connectionstatechange", (s) => gen === this.gen && this.onTransportState(t, s));
    return t;
  }

  private onTransportState(t: ms.Transport, s: RTCPeerConnectionState) {
    const timer = this.iceTimers.get(t.id);
    if (timer) clearTimeout(timer);
    this.iceTimers.delete(t.id);
    if (s === "connected") {
      if (this.state === "connecting" || this.state === "reconnecting") this.setState("connected");
      return;
    }
    if (s === "disconnected") {
      // Often recovers by itself (Wi-Fi blip); restart ICE if it does not within 2 s.
      this.iceTimers.set(t.id, setTimeout(() => void this.restartIce(t), 2_000));
      return;
    }
    if (s === "failed") void this.restartIce(t);
  }

  private async restartIce(t: ms.Transport) {
    if (t.closed || this.state === "ended") return;
    if (this.state === "connected") this.setState("reconnecting");
    try {
      const { iceParameters } = await this.sig!.request<{ iceParameters: ms.IceParameters }>("restartIce", { transportId: t.id });
      await t.restartIce({ iceParameters });
    } catch {
      // The signaling socket is gone too: rebuild the whole session.
      void this.reconnect();
    }
  }

  private onSignalingClosed(code: number, info: { code?: string }) {
    if (this.state === "ended") return;
    if (info.code === "call_ended" || info.code === "removed") return this.finish();
    if (code === 4009) {
      this.endedHere = "replaced";
      return this.finish();
    }
    void this.reconnect();
  }

  /** New grant (the seat is kept for a while on the server) → new signaling socket and transports. */
  private async reconnect() {
    if (this.reconnecting || this.state === "ended") return;
    this.reconnecting = true;
    this.setState("reconnecting");
    const started = Date.now();
    try {
      for (let attempt = 0; (this.state as CallState) !== "ended"; attempt++) {
        try {
          const { call, media } = await this.client.rpc<{ call: CallInfo; media: MediaGrant }>("call.join", `/v1/calls/${this.id}/join`, { callId: this.id });
          this.update(call);
          if ((this.state as CallState) === "ended") return;
          await this.connect(media);
          return;
        } catch (err) {
          const code = err instanceof ChatError ? err.code : "";
          if (FATAL.has(code) || Date.now() - started > RECONNECT_GIVE_UP_MS) {
            this.emitter.emit("error", err instanceof ChatError ? err : new ChatError({ code: "failed", message: String(err) }));
            return this.finish();
          }
          await sleep(backoffDelay(attempt, 500, 5_000));
        }
      }
    } finally {
      this.reconnecting = false;
    }
  }

  private async onNotify(t: string, d: Record<string, unknown>) {
    switch (t) {
      case "peerJoined":
        this.remote(d.userId as string).inCall = true;
        return this.emitParticipants();
      case "peerLeft": {
        const r = this.remote(d.userId as string);
        r.inCall = false;
        for (const x of r.tracks.values()) x.consumer.close();
        r.tracks.clear();
        this.levels.delete(d.userId as string);
        return this.emitParticipants();
      }
      case "newConsumer": {
        if (!this.recvT) return;
        const consumer = await this.recvT.consume({
          id: d.id as string,
          producerId: d.producerId as string,
          kind: d.kind as "audio" | "video",
          rtpParameters: d.rtpParameters as ms.RtpParameters,
          appData: { userId: d.userId, source: d.source },
        });
        const rt: RemoteTrack = { consumer, source: d.source as TrackSource, paused: d.producerPaused === true };
        const r = this.remote(d.userId as string);
        r.inCall = true;
        r.tracks.set(consumer.id, rt);
        await this.applyPreference(rt);
        return this.emitParticipants();
      }
      case "consumerClosed":
      case "consumerPaused":
      case "consumerResumed": {
        for (const r of this.remotes.values()) {
          const x = r.tracks.get(d.consumerId as string);
          if (!x) continue;
          if (t === "consumerClosed") {
            x.consumer.close();
            r.tracks.delete(d.consumerId as string);
          } else x.paused = t === "consumerPaused";
        }
        return this.emitParticipants();
      }
      case "activeSpeaker":
        this.activeSpeaker = (d.userId as string) ?? null;
        this.emitter.emit("activeSpeaker", this.activeSpeaker);
        return;
      case "audioLevels": {
        this.levels.clear();
        // dBov from the server (−65 threshold … 0) → 0–1.
        for (const l of (d.levels as { userId: string; volume: number }[]) ?? []) this.levels.set(l.userId, Math.max(0.01, Math.min(1, (l.volume + 65) / 65)));
        return this.emitParticipants();
      }
      case "forceMute": {
        const source = d.source as "mic" | "camera" | "screen";
        if (source === "screen") await this.stopScreenShare();
        else {
          this.producers.get(source)?.pause();
          this.mutedSources.add(source);
          if (this.local[source]) this.local[source]!.enabled = false;
          this.emitLocal();
        }
        this.emitter.emit("forceMute", source);
        return;
      }
    }
  }

  private async applyPreference(rt: RemoteTrack) {
    const userId = rt.consumer.appData.userId as string;
    const pref = rt.source === "camera" ? (this.videoPrefs.get(userId) ?? "high") : "high";
    await this.sig
      ?.request("consumerPreferences", {
        consumerId: rt.consumer.id,
        paused: pref === "off",
        ...(rt.source === "camera" && pref !== "off" ? { spatialLayer: LAYER[pref] } : {}),
      })
      .catch(() => {});
  }

  private async produce(source: TrackSource) {
    const track = this.local[source];
    if (!track || !this.sendT || this.sendT.closed) return;
    const paused = this.mutedSources.has(source);
    const opts: ms.ProducerOptions =
      source === "camera"
        ? { encodings: CAMERA_ENCODINGS, codecOptions: { videoGoogleStartBitrate: 1000 } }
        : source === "screen"
          ? { encodings: SCREEN_ENCODINGS, codecOptions: { videoGoogleStartBitrate: 1000 } }
          : { codecOptions: { opusStereo: source === "screen-audio", opusDtx: source === "mic", opusFec: true } };
    const p = await this.sendT.produce({ track, ...opts, stopTracks: false, appData: { source, paused } });
    if (paused) p.pause();
    this.producers.set(source, p);
  }

  private async setPaused(source: "mic" | "camera", paused: boolean) {
    if (paused) this.mutedSources.add(source);
    else this.mutedSources.delete(source);
    const track = this.local[source];
    if (track) track.enabled = !paused;
    const p = this.producers.get(source);
    if (p) {
      if (paused) p.pause();
      else p.resume();
      await this.sig?.request(paused ? "pauseProducer" : "resumeProducer", { producerId: p.id }).catch(() => {});
    }
    this.emitLocal();
  }

  private async userTrack(kind: "audio" | "video", constraints?: MediaTrackConstraints): Promise<MediaStreamTrack> {
    const v = this.client.options.video ?? {};
    const video = { width: { ideal: v.width ?? 1280 }, height: { ideal: v.height ?? 720 }, frameRate: { ideal: v.frameRate ?? 30 }, facingMode: this.facingMode, ...constraints };
    try {
      const s = await this.client.devices().getUserMedia(kind === "audio" ? { audio: { ...AUDIO, ...constraints } } : { video });
      return kind === "audio" ? s.getAudioTracks()[0]! : s.getVideoTracks()[0]!;
    } catch (err) {
      throw mediaError(err);
    }
  }

  private async replaceInput(source: "mic" | "camera", constraints: MediaTrackConstraints) {
    const track = await this.userTrack(source === "mic" ? "audio" : "video", constraints);
    track.enabled = !this.mutedSources.has(source);
    const old = this.local[source];
    this.local[source] = track;
    const p = this.producers.get(source);
    if (p) await p.replaceTrack({ track });
    else await this.produce(source);
    old?.stop();
    this.emitLocal();
  }

  private remote(userId: string): Remote {
    let r = this.remotes.get(userId);
    if (!r) this.remotes.set(userId, (r = { inCall: false, tracks: new Map() }));
    return r;
  }

  private watchNetwork() {
    if (this.detachOnline) return;
    const g = globalThis as { addEventListener?: (e: string, cb: () => void) => void; removeEventListener?: (e: string, cb: () => void) => void };
    if (typeof g.addEventListener !== "function") return;
    // Network switched (Wi-Fi ↔ mobile): new candidates are needed right away.
    const online = () => {
      for (const t of [this.sendT, this.recvT]) if (t && !t.closed) void this.restartIce(t);
    };
    g.addEventListener("online", online);
    this.detachOnline = () => g.removeEventListener?.("online", online);
  }

  private startStats() {
    if (this.statsTimer) return;
    this.statsTimer = setInterval(async () => {
      if (this.state !== "connected" && this.state !== "reconnecting") return;
      const s = await this.getStats();
      if (s.quality !== this.quality) {
        this.quality = s.quality;
        this.emitter.emit("quality", s.quality, s);
      }
    }, 3_000);
  }

  private closeSession() {
    for (const t of this.iceTimers.values()) clearTimeout(t);
    this.iceTimers.clear();
    this.sig?.close();
    this.sig = null;
    this.sendT?.close();
    this.recvT?.close();
    this.sendT = this.recvT = null;
    this.producers.clear();
    for (const r of this.remotes.values()) {
      for (const x of r.tracks.values()) x.consumer.close();
      r.tracks.clear();
    }
  }

  private stopLocal() {
    for (const t of Object.values(this.local)) t?.stop();
    this.local = {};
  }

  /** Internal: tears everything down once; emits "ended". */
  finish() {
    if (this.state === "ended") return;
    this.gen++;
    this.closeSession();
    this.stopLocal();
    if (this.statsTimer) clearInterval(this.statsTimer);
    this.statsTimer = null;
    this.detachOnline?.();
    this.detachOnline = null;
    this.setState("ended");
    this.client.release(this);
    this.emitter.emit("ended", this.info);
  }

  private setState(s: CallState) {
    if (this.state === s) return;
    this.state = s;
    this.emitter.emit("state", s);
    this.emitParticipants();
  }

  private emitLocal() {
    this.emitter.emit("local");
    this.emitParticipants();
  }

  private emitParticipants() {
    this.emitter.emit("participants", this.participants);
  }
}
