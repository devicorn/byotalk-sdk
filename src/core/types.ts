export type Json = Record<string, unknown>;
export type Unsubscribe = () => void;

export type ConnectionState = "disconnected" | "connecting" | "syncing" | "connected" | "reconnecting" | "failed";

export interface Attachment {
  id: string;
  name: string;
  size: number;
  mimeType: string;
  width?: number | null;
  height?: number | null;
}

export interface Message {
  /** null while sending */
  id: string | null;
  /** own messages only */
  clientMsgId: string | null;
  conversationId: string;
  seq: number | null;
  senderId: string;
  text: string | null;
  replyTo: string | null;
  attachments: Attachment[];
  metadata: Json;
  version: number;
  status: "sending" | "sent" | "failed";
  error?: import("./errors.js").ChatError;
  /** server time once sent; local time while sending */
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
}

export interface Member {
  userId: string;
  role: "owner" | "member";
  lastReadSeq?: number;
  lastDeliveredSeq?: number;
}

export interface ConversationSummary {
  id: string;
  type: "direct" | "group";
  name: string | null;
  metadata: Json;
  lastSeq: number;
  unreadCount: number;
  lastReadSeq: number;
  muted: boolean;
  lastActivityAt: string;
  lastMessage: Omit<Message, "status" | "clientMsgId"> | null;
}

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export interface Presence {
  userId: string;
  online: boolean;
  lastSeenAt: string | null;
}

export interface MemberEvent {
  userIds?: string[];
  userId?: string;
  actorId: string | null;
  reason?: "removed" | "left";
}

export interface PersistenceAdapter {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** File input: browser Blob/File, or React Native `{ uri, name, type }`. */
export type UploadInput = Blob | { uri: string; name: string; type: string };

/** Payload of a protocol frame (shapes in docs/08-REALTIME-PROTOCOL.md); the server validates what it sends. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WireData = any;

export interface WireFrame {
  t: string;
  re?: string;
  e?: string;
  cid?: string;
  seq?: number;
  d?: WireData;
  code?: string;
  message?: string;
  retryAfterMs?: number;
}
