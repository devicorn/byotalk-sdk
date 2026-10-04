// Errors mirror the server catalogue (docs/07-API-REFERENCE.md §1.7).

const RETRYABLE = new Set(["rate_limited", "plan_limit_reached", "history_unavailable", "storage_unavailable", "internal", "network", "timeout", "resync_required"]);

export class ChatError extends Error {
  readonly code: string;
  readonly type: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(init: { code: string; type?: string; message: string; requestId?: string; retryAfterMs?: number; status?: number }) {
    super(init.message);
    this.name = "ChatError";
    this.code = init.code;
    this.type = init.type ?? (init.code === "network" ? "network" : "internal");
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.status = init.status;
    this.retryable = RETRYABLE.has(init.code) || (init.status !== undefined && init.status >= 500);
  }
}

/** Older history lives in a customer database that is temporarily unreachable; loaded pages stay. */
export class HistoryUnavailableError extends ChatError {
  constructor(init: ConstructorParameters<typeof ChatError>[0]) {
    super(init);
    this.name = "HistoryUnavailableError";
  }
}

export function errorFromBody(status: number, body: unknown): ChatError {
  const e = (body as { error?: { code?: string; type?: string; message?: string; requestId?: string; retryAfterMs?: number } } | null)?.error;
  const init = {
    code: e?.code ?? (status >= 500 ? "internal" : "invalid_request"),
    type: e?.type,
    message: e?.message ?? `Request failed with status ${status}`,
    requestId: e?.requestId,
    retryAfterMs: e?.retryAfterMs,
    status,
  };
  return init.code === "history_unavailable" ? new HistoryUnavailableError(init) : new ChatError(init);
}

export const networkError = (message = "Network request failed") => new ChatError({ code: "network", type: "network", message });
