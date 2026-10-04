// Attachment uploads: request a signed upload, send the file straight to the media store, then complete.
import { ChatError } from "./errors.js";
import type { RestClient } from "./rest.js";
import type { Attachment, UploadInput } from "./types.js";

interface UploadTicket {
  attachmentId: string;
  upload: { method: "POST"; url: string; fields: Record<string, string> };
}

const isBlob = (f: UploadInput): f is Blob => typeof Blob !== "undefined" && f instanceof Blob;

export class Uploader {
  constructor(private readonly rest: RestClient) {}

  async upload(conversationId: string, file: UploadInput, opts: { onProgress?: (p: number) => void; signal?: AbortSignal }): Promise<Attachment> {
    const name = isBlob(file) ? ((file as File).name ?? "file") : file.name;
    const type = isBlob(file) ? file.type || "application/octet-stream" : file.type;
    const size = isBlob(file) ? file.size : await sizeOfUri(file.uri);
    const ticket = await this.rest.request<UploadTicket>("POST", "/v1/uploads", {
      body: { conversationId, filename: name, size, contentType: type },
      signal: opts.signal,
    });
    const form = new FormData();
    for (const [k, v] of Object.entries(ticket.upload.fields)) form.append(k, v);
    // React Native's FormData accepts { uri, name, type } objects.
    form.append("file", file as Blob, name);
    await post(ticket.upload.url, form, opts);
    opts.onProgress?.(1);
    return this.rest.request<Attachment>("POST", `/v1/uploads/${ticket.attachmentId}/complete`, { signal: opts.signal });
  }
}

async function sizeOfUri(uri: string): Promise<number> {
  try {
    const res = await fetch(uri);
    return (await res.blob()).size;
  } catch {
    return 1;
  }
}

/** XHR when available (upload progress), fetch otherwise. */
function post(url: string, form: FormData, opts: { onProgress?: (p: number) => void; signal?: AbortSignal }): Promise<void> {
  const XHR = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
  if (XHR && opts.onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XHR();
      xhr.open("POST", url);
      xhr.upload.onprogress = (e) => e.lengthComputable && opts.onProgress!(e.loaded / e.total);
      xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(uploadError(xhr.status)));
      xhr.onerror = () => reject(new ChatError({ code: "storage_unavailable", type: "unavailable", message: "Upload failed" }));
      opts.signal?.addEventListener("abort", () => xhr.abort());
      xhr.send(form);
    });
  }
  return fetch(url, { method: "POST", body: form, signal: opts.signal }).then((res) => {
    if (!res.ok) throw uploadError(res.status);
  });
}

const uploadError = (status: number) =>
  status === 413 || status === 400
    ? new ChatError({ code: "file_too_large", type: "payload_too_large", message: `Upload rejected (${status})`, status })
    : new ChatError({ code: "storage_unavailable", type: "unavailable", message: `Upload failed (${status})`, status });
