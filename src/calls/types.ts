import type { types as ms } from "mediasoup-client";
import type { WebSocketCtor } from "../core/transport.js";

export type CallKind = "audio" | "video";
/** Server status of the call. */
export type CallStatus = "ringing" | "active" | "ended";
export type CallEndReason = "completed" | "missed" | "declined" | "cancelled" | "busy" | "failed" | "ended_by_server";
export type ParticipantState = "ringing" | "joining" | "joined" | "left" | "declined" | "missed" | "busy";

/** The call as the server sees it (also the payload of the call.started / call.ended webhooks). */
export interface CallInfo {
  id: string;
  conversationId: string;
  kind: CallKind;
  status: CallStatus;
  createdBy: string;
  createdAt: string;
  answeredAt: string | null;
  endedAt: string | null;
  endReason: CallEndReason | null;
  durationSeconds: number;
  metadata: Record<string, unknown>;
  participants: { userId: string; state: ParticipantState; invitedAt: string; joinedAt: string | null; leftAt: string | null }[];
}

export interface MediaGrant {
  url: string;
  token: string;
  iceServers: RTCIceServer[];
}

/**
 * This device's view of the call:
 * - `incoming`: ringing here, not answered yet
 * - `connecting` / `connected` / `reconnecting`: media session state
 * - `ended`: the call ended, or it was answered or declined on another device (see `Call.endedHere`)
 */
export type CallState = "incoming" | "connecting" | "connected" | "reconnecting" | "ended";

export type TrackSource = "mic" | "camera" | "screen" | "screen-audio";

export interface Participant {
  userId: string;
  isLocal: boolean;
  /** Server participant state (ringing, joined, left, …). */
  state: ParticipantState;
  /** Connected to the media server right now. */
  inCall: boolean;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  screenTrack: MediaStreamTrack | null;
  screenAudioTrack: MediaStreamTrack | null;
  /** No microphone track, or it is paused. */
  audioMuted: boolean;
  /** No camera track, or it is paused. */
  videoMuted: boolean;
  /** Currently above the speaking threshold. */
  speaking: boolean;
  /** 0–1 audio level (0 when silent). */
  audioLevel: number;
}

export type VideoQuality = "off" | "low" | "medium" | "high";

export type NetworkQuality = "good" | "fair" | "poor" | "unknown";

export interface CallStats {
  quality: NetworkQuality;
  /** Round-trip time to the media server. */
  rttMs: number | null;
  /** Estimated upload bandwidth. */
  availableOutgoingBitrate: number | null;
  /** Share of incoming packets lost since the previous sample, 0–1. */
  packetLoss: number | null;
  bytesSent: number;
  bytesReceived: number;
  /** Candidate type in use: host, srflx, relay (TURN). */
  candidateType: string | null;
}

export interface CallOptions {
  /** Force media through TURN ("relay"), e.g. to test restrictive networks. */
  iceTransportPolicy?: RTCIceTransportPolicy;
  /** mediasoup-client device options; the browser/React Native handler is detected automatically. */
  device?: ms.DeviceOptions;
  /** getUserMedia / getDisplayMedia provider (react-native-webrtc's mediaDevices on React Native). */
  mediaDevices?: Pick<MediaDevices, "getUserMedia"> & Partial<Pick<MediaDevices, "getDisplayMedia" | "enumerateDevices">>;
  WebSocket?: WebSocketCtor;
  /** Camera capture settings (default 1280×720 at 30 fps). */
  video?: { width?: number; height?: number; frameRate?: number };
}
