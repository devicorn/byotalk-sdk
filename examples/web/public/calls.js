// Voice and video calls for the example app, on `byotalk/calls` (served as /sdk/calls.js).
import { CallClient } from "/sdk/calls.js";
import { avatar, icon } from "./icons.js";

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
let toast = () => {};
let conversation = null;
let clock = null;
const media = new Map(); // `${userId}:${kind}` → <video>/<audio>, reused so playback does not restart

export function initCalls(chat, lookupName, showError) {
  nameOf = lookupName;
  toast = showError;
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
    (call.localMedia.screenSharing ? call.stopScreenShare() : call.startScreenShare()).catch(report);
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
  try {
    show(await calls.start(conversation.id, { video }));
  } catch (err) {
    toast(err); // e.g. media_permission_denied: nobody was rung
  }
}

async function joinLive() {
  const { data } = await calls.chat.rest.request("GET", "/v1/calls", { query: { conversationId: conversation.id, live: true, limit: 1 } });
  if (!data[0]) return;
  $("join-call").hidden = true;
  try {
    show(await calls.join(data[0].id));
  } catch (err) {
    toast(err);
  }
}

// ------------------------------------------------------------------ incoming

async function ring(c) {
  const name = await nameOf(c.info.createdBy);
  $("incoming-avatar").replaceChildren(avatar(c.info.createdBy, name, 88));
  $("incoming-name").textContent = name;
  $("incoming-text").textContent = `Incoming ${c.kind === "video" ? "video" : "voice"} call…`;
  $("accept-video-wrap").hidden = c.kind !== "video";
  $("incoming").hidden = false;
  const close = () => {
    $("incoming").hidden = true;
    off();
  };
  // Answered or declined on another device, cancelled by the caller, or missed.
  const off = c.on("ended", close);
  $("accept-video").onclick = () => answer(c, true, close);
  $("accept-audio").onclick = () => answer(c, false, close);
  $("decline").onclick = () => {
    close();
    void c.decline().catch(toast);
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
  $("call-title").textContent = "";
  void titleFor(c).then((t) => call === c && ($("call-title").textContent = t));
  for (const e of ["participants", "state", "updated", "local", "activeSpeaker"]) c.on(e, render);
  c.on("quality", (q) => ($("call-quality").dataset.q = q));
  c.on("forceMute", (s) => report({ message: `Your ${s === "mic" ? "microphone" : s} was muted by the host` }));
  c.on("error", report);
  c.on("ended", () => {
    clearInterval(clock);
    render();
    setTimeout(() => {
      if (call !== c) return;
      $("call").hidden = true;
      $("tiles").replaceChildren();
      $("call-sound").replaceChildren();
      for (const m of media.values()) m.srcObject = null;
      media.clear();
      delete $("call-quality").dataset.q;
      call = null;
    }, 1600);
  });
  clearInterval(clock);
  clock = setInterval(render, 1000);
  render();
}

async function titleFor(c) {
  if (conversation?.id === c.conversationId && conversation.name) return conversation.name;
  const others = c.info.participants.map((p) => p.userId).filter((u) => u !== calls.me);
  const n = await Promise.all(others.slice(0, 3).map(nameOf));
  return n.join(", ") + (others.length > 3 ? ` +${others.length - 3}` : "");
}

function endText(c) {
  if (c.endedHere === "answered_elsewhere") return "Answered on another device";
  if (c.endedHere === "replaced") return "Call moved to another device";
  const r = c.info.endReason;
  return { missed: "No answer", declined: "Declined", busy: "Busy on another call", cancelled: "Call cancelled", failed: "Call failed" }[r] ?? "Call ended";
}

function statusText(c) {
  if (c.state === "ended") return endText(c);
  if (c.state === "reconnecting") return "Reconnecting…";
  if (c.status === "ringing") return c.direction === "outgoing" ? "Ringing…" : "Connecting…";
  if (c.state !== "connected") return "Connecting…";
  const s = c.info.answeredAt ? Math.max(0, Math.floor((Date.now() - Date.parse(c.info.answeredAt)) / 1000)) : 0;
  const h = Math.floor(s / 3600);
  const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
  return `${h ? `${h}:` : ""}${mm}:${String(s % 60).padStart(2, "0")}`;
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

function setButton(btn, iconName, label, off) {
  btn.replaceChildren(icon(iconName, 22));
  btn.classList.toggle("off", off);
  btn.setAttribute("aria-label", label);
  btn.title = label;
}

function render() {
  const c = call;
  if (!c) return;
  $("call-status").textContent = statusText(c);
  const lm = c.localMedia;
  setButton($("mic"), lm.micEnabled ? "mic" : "mic-off", lm.micEnabled ? "Mute microphone" : "Unmute microphone", !lm.micEnabled);
  setButton($("cam"), lm.cameraEnabled ? "video" : "video-off", lm.cameraEnabled ? "Turn camera off" : "Turn camera on", !lm.cameraEnabled);
  $("share").classList.toggle("off", lm.screenSharing);
  $("share").title = lm.screenSharing ? "Stop sharing" : "Share screen";
  $("flip").hidden = !lm.cameraEnabled;

  const shown = c.participants.filter((p) => p.isLocal || p.inCall || p.state === "ringing" || p.state === "joining");
  const sharing = shown.some((p) => p.screenTrack);
  const duo = shown.length === 2 && !sharing;
  const tiles = [];
  const audio = [];
  for (const p of shown) {
    for (const kind of ["video", "screen"]) {
      const track = kind === "video" ? p.videoTrack : p.screenTrack;
      if (kind === "screen" && !track) continue;
      const speaking = kind === "video" && !p.audioMuted && (p.speaking || c.activeSpeaker === p.userId);
      const waiting = !p.isLocal && !p.inCall;
      const tile = el("figure", `tile ${p.isLocal ? "local" : "remote"}${speaking ? " speaking" : ""}${kind === "screen" ? " screen" : ""}${waiting ? " waiting" : ""}`);
      const name = names(p.userId);
      if (track) {
        const v = mediaEl(`${p.userId}:${kind}`, "video", track);
        v.muted = true; // audio plays through the <audio> elements below
        v.classList.toggle("mirror", p.isLocal && kind === "video");
        tile.append(v);
      } else {
        const a = avatar(p.userId, name, 96);
        a.classList.add("big");
        tile.append(a);
      }
      const cap = el("figcaption");
      if (kind === "video" && p.audioMuted && !waiting) cap.append(icon("mic-off", 14));
      if (kind === "screen") cap.append(icon("screen", 14));
      cap.append(kind === "screen" ? (p.isLocal ? "Your screen" : `${name}'s screen`) : `${name}${p.isLocal ? " (you)" : ""}`);
      tile.append(cap);
      if (waiting) tile.append(el("span", "state", p.state === "ringing" ? "Ringing…" : "Connecting…"));
      tiles.push(tile);
    }
    // Remote audio (never the local microphone: that would echo).
    if (!p.isLocal) audio.push(mediaEl(`${p.userId}:audio`, "audio", p.audioTrack), mediaEl(`${p.userId}:screen-audio`, "audio", p.screenAudioTrack));
  }
  $("tiles").classList.toggle("duo", duo);
  // Screen share: the screen takes the stage, cameras line up beside it.
  $("tiles").classList.toggle("sharing", sharing);
  $("tiles").style.setProperty("--cams", String(Math.max(1, tiles.filter((t) => !t.classList.contains("screen")).length)));
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
