// Voice and video calls for the example app, on `byotalk/calls` (served as /sdk/calls.js).
import { CallClient } from "/sdk/calls.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

let calls = null;
let call = null; // the call shown in the overlay
let nameOf = async (id) => id;
let conversation = null;
let clock = null;
const media = new Map(); // `${userId}:${kind}` → <video>/<audio>, reused so playback does not restart

export function initCalls(chat, lookupName) {
  nameOf = lookupName;
  calls = new CallClient(chat);
  calls.on("incoming", (c) => void ring(c));
  $("call-audio").addEventListener("click", () => void place(false));
  $("call-video").addEventListener("click", () => void place(true));
  $("join-call").addEventListener("click", () => void joinLive());
  $("mic").addEventListener("click", () => call && void call.setMicrophoneEnabled(!call.localMedia.micEnabled).catch(report));
  $("cam").addEventListener("click", () => call && void call.setCameraEnabled(!call.localMedia.cameraEnabled).catch(report));
  $("flip").addEventListener("click", () => call && void call.switchCamera().catch(report));
  $("share").addEventListener("click", () => {
    if (!call) return;
    const p = call.localMedia.screenSharing ? call.stopScreenShare() : call.startScreenShare();
    p.catch(report);
  });
  $("hangup").addEventListener("click", () => call && void call.leave());
}

/** The open conversation changed: offer "Join call" if it has a call in progress. */
export async function setConversation(conv) {
  conversation = conv;
  $("join-call").hidden = true;
  const { data } = await calls.chat.rest.request("GET", "/v1/calls", { query: { conversationId: conv.id, live: true, limit: 1 } }).catch(() => ({ data: [] }));
  if (conversation === conv && data[0] && !calls.active) $("join-call").hidden = false;
}

function report(err) {
  $("call-error").textContent = err ? `${err.message}${err.code ? ` (${err.code})` : ""}` : "";
}

async function place(video) {
  if (!conversation) return;
  report();
  try {
    show(await calls.start(conversation.id, { video }));
  } catch (err) {
    report(err);
    $("call").hidden = false;
    $("call-status").textContent = "Could not start the call";
  }
}

async function joinLive() {
  const { data } = await calls.chat.rest.request("GET", "/v1/calls", { query: { conversationId: conversation.id, live: true, limit: 1 } });
  if (!data[0]) return;
  $("join-call").hidden = true;
  try {
    show(await calls.join(data[0].id));
  } catch (err) {
    report(err);
  }
}

// ------------------------------------------------------------------ incoming

async function ring(c) {
  const dialog = $("incoming");
  $("incoming-text").textContent = `${await nameOf(c.info.createdBy)} is calling you (${c.kind === "video" ? "video" : "voice"} call)`;
  dialog.hidden = false;
  const close = () => {
    dialog.hidden = true;
    off();
  };
  // Answered or declined on another device, cancelled by the caller, or missed.
  const off = c.on("ended", close);
  $("accept-video").hidden = c.kind !== "video";
  $("accept-video").onclick = () => answer(c, true, close);
  $("accept-audio").onclick = () => answer(c, false, close);
  $("decline").onclick = () => {
    close();
    void c.decline().catch(report);
  };
}

async function answer(c, video, close) {
  close();
  show(c);
  try {
    await c.accept({ video });
  } catch (err) {
    report(err);
  }
}

// ------------------------------------------------------------------ in-call view

function show(c) {
  call = c;
  report();
  $("call").hidden = false;
  c.on("participants", render);
  c.on("state", render);
  c.on("updated", render);
  c.on("local", render);
  c.on("activeSpeaker", render);
  c.on("quality", (q) => ($("call-quality").textContent = q === "unknown" ? "" : `network: ${q}`));
  c.on("forceMute", (s) => report({ message: `Your ${s === "mic" ? "microphone" : s} was muted by the host` }));
  c.on("error", report);
  c.on("ended", () => {
    clearInterval(clock);
    $("call-status").textContent = endText(c);
    setTimeout(() => {
      if (call !== c) return;
      $("call").hidden = true;
      $("tiles").replaceChildren();
      for (const m of media.values()) m.srcObject = null;
      media.clear();
      call = null;
    }, 1500);
  });
  clearInterval(clock);
  clock = setInterval(render, 1000);
  render();
}

function endText(c) {
  if (c.endedHere === "answered_elsewhere") return "Answered on another device";
  if (c.endedHere === "replaced") return "Call moved to another device";
  const r = c.info.endReason;
  return { missed: "No answer", declined: "Declined", busy: "Busy", cancelled: "Call cancelled", failed: "Call failed" }[r] ?? "Call ended";
}

function statusText(c) {
  if (c.state === "ended") return endText(c);
  if (c.state === "reconnecting") return "Reconnecting…";
  if (c.status === "ringing") return c.direction === "outgoing" ? "Ringing…" : "Connecting…";
  if (c.state !== "connected") return "Connecting…";
  const s = c.info.answeredAt ? Math.max(0, Math.floor((Date.now() - Date.parse(c.info.answeredAt)) / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** One <video>/<audio> per track, reused across renders so playback never restarts. */
function mediaEl(key, tag, track) {
  let m = media.get(key);
  if (!m) {
    m = document.createElement(tag);
    m.autoplay = true;
    m.playsInline = true;
    media.set(key, m);
  }
  if (m.srcObject?.getTracks()[0] !== track) m.srcObject = track ? new MediaStream([track]) : null;
  return m;
}

function render() {
  const c = call;
  if (!c) return;
  $("call-status").textContent = statusText(c);
  const lm = c.localMedia;
  $("mic").textContent = lm.micEnabled ? "🎤 Mute" : "🔇 Unmute";
  $("cam").textContent = lm.cameraEnabled ? "📷 Camera off" : "📷 Camera on";
  $("share").textContent = lm.screenSharing ? "🖥 Stop sharing" : "🖥 Share screen";
  $("flip").hidden = !lm.cameraEnabled;

  const shown = c.participants.filter((p) => p.isLocal || p.inCall || p.state === "ringing" || p.state === "joining");
  const tiles = [];
  const audio = [];
  for (const p of shown) {
    for (const [kind, track] of [["video", p.videoTrack], ["screen", p.screenTrack]]) {
      if (kind === "screen" && !track) continue;
      const tile = el("figure", `tile${p.speaking || (c.activeSpeaker === p.userId && !p.audioMuted) ? " speaking" : ""}${kind === "screen" ? " screen" : ""}`);
      if (track) {
        const v = mediaEl(`${p.userId}:${kind}`, "video", track);
        v.muted = true; // audio plays through the <audio> elements below
        if (p.isLocal && kind === "video") v.classList.add("mirror");
        tile.append(v);
      } else {
        tile.append(el("div", "avatar", (names(p.userId)[0] ?? "?").toUpperCase()));
      }
      const label = el("figcaption", "", `${names(p.userId)}${p.isLocal ? " (you)" : ""}${kind === "screen" ? " · screen" : ""}`);
      if (kind === "video" && p.audioMuted) label.append(" 🔇");
      if (!p.isLocal && !p.inCall) label.append(p.state === "ringing" ? " · ringing" : " · connecting");
      tile.append(label);
      tiles.push(tile);
    }
    // Remote audio (never the local microphone: that would echo).
    if (!p.isLocal) audio.push(mediaEl(`${p.userId}:audio`, "audio", p.audioTrack), mediaEl(`${p.userId}:screen-audio`, "audio", p.screenAudioTrack));
  }
  // Re-inserting a playing element in the same task does not pause it.
  $("tiles").replaceChildren(...tiles);
  $("call-sound").replaceChildren(...audio);
}

const nameCache = new Map();
function names(userId) {
  if (!nameCache.has(userId)) {
    nameCache.set(userId, userId);
    void nameOf(userId).then((n) => {
      nameCache.set(userId, n);
      render();
    });
  }
  return nameCache.get(userId);
}
