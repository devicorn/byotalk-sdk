// Example chat client built on the `byotalk` SDK (served from ../../dist as /sdk/index.js).
// All user content is rendered with textContent, never innerHTML.
import { Chat, localStoragePersistence } from "/sdk/index.js";
import { initCalls, setConversation } from "./calls.js";
import { avatar, hydrateIcons, icon } from "./icons.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
function dayLabel(iso) {
  const d = new Date(iso);
  const today = new Date();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, today.getTime() - 86_400_000)) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", ...(d.getFullYear() !== today.getFullYear() ? { year: "numeric" } : {}) });
}
const shortWhen = (iso) => (sameDay(iso, Date.now()) ? time(iso) : new Date(iso).toLocaleDateString([], { month: "short", day: "numeric" }));
const errText = (err) => `${err.message ?? err}${err.code ? ` (${err.code})` : ""}${err.requestId ? ` · ${err.requestId}` : ""}`;

let toastTimer = null;
/** Errors show as a toast for a few seconds. */
function toast(err) {
  const t = $("toast");
  t.textContent = errText(err);
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 5000);
}

let chat = null;
let me = null;
let current = null; // open Conversation
let stopCurrent = [];
let lastList = [];
const labels = new Map(); // conversation id → display title
const names = new Map(); // user id → display name

hydrateIcons();

// ------------------------------------------------------------------ sign in

async function fetchToken(userId, name) {
  const res = await fetch(`/api/token?userId=${encodeURIComponent(userId)}&name=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

for (const chip of document.querySelectorAll(".chip[data-user]")) {
  chip.addEventListener("click", () => {
    const f = $("login-form").elements;
    f.userId.value = chip.dataset.user;
    f.name.value = chip.dataset.user[0].toUpperCase() + chip.dataset.user.slice(1);
    $("login-form").requestSubmit();
  });
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const userId = form.get("userId").trim();
  const name = form.get("name").trim() || userId;
  $("login-error").textContent = "";
  try {
    const first = await fetchToken(userId, name);
    me = { id: userId, name };
    sessionStorage.setItem("byotalk-example-user", JSON.stringify(me));
    await start(first);
  } catch (err) {
    $("login-error").textContent = errText(err);
  }
});

$("logout").addEventListener("click", async () => {
  sessionStorage.removeItem("byotalk-example-user");
  await chat?.disconnect();
  location.reload();
});

async function start(first) {
  let initial = first.token;
  chat = new Chat({
    env: first.env,
    baseUrl: first.apiUrl,
    realtimeUrl: first.rtUrl,
    // Called before the token expires and after a token_expired close.
    token: async () => {
      if (initial) {
        const t = initial;
        initial = null;
        return t;
      }
      return (await fetchToken(me.id, me.name)).token;
    },
    persistence: localStoragePersistence(), // unsent messages survive a reload
  });
  chat.on("connection", (s) => {
    $("conn").dataset.state = s;
    $("conn").querySelector("b").textContent = s === "connected" ? "online" : s;
  });
  chat.on("error", toast);

  $("login").hidden = true;
  $("app").hidden = false;
  $("me-name").textContent = me.name;
  $("me-avatar").replaceChildren(avatar(me.id, me.name, 40));
  await chat.connect();
  initCalls(chat, nameOf, toast);
  chat.conversations.watch((list) => {
    lastList = list;
    void renderConversations();
  });
}

// ------------------------------------------------------------------ new chat panel

$("new-toggle").addEventListener("click", () => {
  const panel = $("new-panel");
  panel.hidden = !panel.hidden;
  $("new-toggle").setAttribute("aria-expanded", String(!panel.hidden));
  if (!panel.hidden) panel.querySelector("form:not([hidden]) input").focus();
});
for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    for (const t of document.querySelectorAll(".tab")) t.setAttribute("aria-selected", String(t === tab));
    $("new-dm").hidden = tab.dataset.tab !== "dm";
    $("new-group").hidden = tab.dataset.tab !== "group";
    $(tab.dataset.tab === "dm" ? "new-dm" : "new-group").querySelector("input").focus();
  });
}
const closeNewPanel = () => {
  $("new-panel").hidden = true;
  $("new-toggle").setAttribute("aria-expanded", "false");
};

$("new-dm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = e.target.elements.userId;
  try {
    const conv = await chat.conversations.direct(input.value.trim());
    input.value = "";
    closeNewPanel();
    await open(conv.id);
  } catch (err) {
    toast(err);
  }
});

$("new-group").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const members = f.members.value.split(",").map((s) => s.trim()).filter(Boolean);
  try {
    const conv = await chat.conversations.create({ name: f.name.value.trim(), members });
    f.name.value = "";
    f.members.value = "";
    closeNewPanel();
    await open(conv.id);
  } catch (err) {
    toast(err);
  }
});

$("search").addEventListener("input", () => void renderConversations());

// ------------------------------------------------------------------ conversation list

async function nameOf(userId) {
  if (names.has(userId)) return names.get(userId);
  try {
    const u = await chat.rest.request("GET", `/v1/users/${encodeURIComponent(userId)}`);
    names.set(userId, u.name || userId);
  } catch {
    names.set(userId, userId);
  }
  return names.get(userId);
}

/** Title and avatar key: the group name, or the other person in a direct chat. */
async function labelFor(summary) {
  if (summary.name) return { label: summary.name, key: summary.id, group: true };
  if (labels.has(summary.id)) return labels.get(summary.id);
  const members = await chat.rest.request("GET", `/v1/conversations/${summary.id}/members`);
  const other = members.data.find((m) => m.userId !== me.id)?.userId ?? me.id;
  const info = { label: await nameOf(other), key: other, group: false, other };
  labels.set(summary.id, info);
  return info;
}

function preview(c) {
  const last = c.lastMessage;
  if (!last) return "No messages yet";
  const body = last.deletedAt ? "Message deleted" : (last.text ?? (last.attachments?.length ? "📎 Attachment" : ""));
  return last.senderId === me.id ? `You: ${body}` : body;
}

async function renderConversations() {
  const q = $("search").value.trim().toLowerCase();
  const rows = await Promise.all(lastList.map(async (c) => ({ c, info: await labelFor(c) })));
  const items = rows
    .filter(({ info }) => !q || info.label.toLowerCase().includes(q))
    .map(({ c, info }) => {
      const li = el("li", c.id === current?.id ? "active" : "");
      const unread = c.unreadCount > 0 && c.id !== current?.id;
      const btn = el("button", `conv${unread ? " has-unread" : ""}`);
      btn.append(avatar(info.key, info.label, 46, info.group), el("span", "conv-title", info.label), el("span", "conv-time", c.lastActivityAt ? shortWhen(c.lastActivityAt) : ""));
      btn.append(el("span", "conv-last", preview(c)));
      btn.append(unread ? el("span", "unread", c.unreadCount > 99 ? "99+" : String(c.unreadCount)) : el("span"));
      btn.addEventListener("click", () => open(c.id));
      li.append(btn);
      return li;
    });
  $("conversations").replaceChildren(...items);
  $("no-convs").hidden = lastList.length > 0;
}

// ------------------------------------------------------------------ open conversation

$("back").addEventListener("click", () => {
  $("app").dataset.view = "list";
  current = null;
  void renderConversations();
});

async function open(id) {
  for (const stop of stopCurrent) stop();
  stopCurrent = [];
  current = await chat.conversations.get(id);
  const conv = current;
  $("app").dataset.view = "thread";
  $("empty").hidden = true;
  $("chat").hidden = false;
  $("older").hidden = false;
  $("older").textContent = "Load older messages";
  const info = await labelFor({ id: conv.id, name: conv.name ?? null });
  $("title").textContent = info.label;
  $("thread-avatar").replaceChildren(avatar(info.key, info.label, 42, info.group));
  $("typing").replaceChildren();
  void renderConversations();

  stopCurrent.push(conv.messages.subscribe(() => renderMessages(conv)));
  stopCurrent.push(conv.on("receipt", () => renderMessages(conv)));
  stopCurrent.push(
    conv.on("typing", async (ids) => {
      const who = await Promise.all(ids.map(nameOf));
      if (!who.length) return $("typing").replaceChildren();
      const dots = el("span", "dots");
      dots.append(el("i"), el("i"), el("i"));
      $("typing").replaceChildren(dots, `${who.join(", ")} ${who.length > 1 ? "are" : "is"} typing`);
    }),
  );
  stopCurrent.push(conv.on("message.new", (m) => m.senderId !== me.id && conv.markRead().catch(() => {})));
  stopCurrent.push(conv.on("removed", () => location.reload()));

  // Presence for direct chats.
  const others = conv.members.filter((m) => m.userId !== me.id).map((m) => m.userId);
  const presence = $("presence");
  presence.className = "muted";
  if (conv.type === "direct" && others.length) {
    presence.textContent = "";
    stopCurrent.push(
      chat.presence.watch(others, (p) => {
        presence.className = p.online ? "online" : "muted";
        presence.textContent = p.online ? "online" : p.lastSeenAt ? `last seen ${dayLabel(p.lastSeenAt).toLowerCase()} at ${time(p.lastSeenAt)}` : "offline";
      }),
    );
  } else {
    presence.textContent = `${conv.members.length} members`;
  }
  renderMessages(conv);
  scrollToBottom();
  await conv.markRead().catch(() => {});
  void setConversation(conv);
  $("text").focus();
}

const scrollToBottom = () => {
  const s = $("scroller");
  s.scrollTop = s.scrollHeight;
};

function renderMessages(conv) {
  if (conv !== current) return;
  const scroller = $("scroller");
  const atBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 60;
  const items = [];
  let prev = null;
  for (const m of conv.messages.items) {
    if (!prev || !sameDay(prev.createdAt, m.createdAt)) items.push(el("li", "day", dayLabel(m.createdAt)));
    // A new run starts when the sender changes or 5 minutes pass.
    const first = !prev || prev.senderId !== m.senderId || !sameDay(prev.createdAt, m.createdAt) || Date.parse(m.createdAt) - Date.parse(prev.createdAt) > 300_000;
    items.push(messageEl(conv, m, first));
    prev = m;
  }
  $("messages").replaceChildren(...items);
  // No messages, or the first one (seq 1) is loaded: nothing older to fetch.
  const oldest = conv.messages.items[0];
  if (!oldest || oldest.seq === 1) $("older").hidden = true;
  if (atBottom) scrollToBottom();
}

function messageEl(conv, m, first) {
  const mine = m.senderId === me.id;
  const li = el("li", `msg ${mine ? "mine" : ""} ${m.status}${first ? " first" : ""}`);
  if (!mine && conv.type === "group" && first) li.append(el("span", "sender", names.get(m.senderId) ?? m.senderId));
  if (m.deletedAt || m.text) li.append(el("p", m.deletedAt ? "text deleted" : "text", m.deletedAt ? "Message deleted" : m.text));
  if (!m.deletedAt) for (const a of m.attachments) li.append(attachmentEl(a));

  const meta = el("span", "meta");
  if (m.editedAt && !m.deletedAt) meta.append("edited ·");
  meta.append(m.status === "sent" ? time(m.createdAt) : m.status === "sending" ? "sending" : "not sent");
  if (mine && !m.deletedAt) {
    if (m.status === "sending") meta.append(icon("clock", 12));
    else if (m.status === "failed") meta.append(icon("alert", 12));
    else if (m.seq !== null) {
      const read = conv.readBy(m.seq).length > 0;
      const tick = icon(read ? "check-check" : "check", 14);
      if (read) tick.classList.add("read");
      tick.title = read ? "Read" : "Sent";
      meta.append(tick);
    }
  }
  li.append(meta);
  if (m.status === "failed") {
    const retry = el("button", "retry", "Retry");
    retry.addEventListener("click", () => conv.retry(m.clientMsgId).catch(toast));
    meta.append(retry);
  }
  if (mine && m.id && !m.deletedAt) {
    const actions = el("span", "actions");
    const edit = el("button");
    edit.append(icon("pencil", 15));
    edit.setAttribute("aria-label", "Edit message");
    edit.addEventListener("click", async () => {
      const text = prompt("Edit message", m.text ?? "");
      if (text !== null && text.trim()) await conv.edit(m.id, { text: text.trim() }).catch(toast);
    });
    const del = el("button");
    del.append(icon("trash", 15));
    del.setAttribute("aria-label", "Delete message");
    del.addEventListener("click", () => confirm("Delete this message for everyone?") && conv.delete(m.id).catch(toast));
    actions.append(edit, del);
    li.append(actions);
  }
  // Names load lazily: re-render once a sender's name arrives.
  if (!mine && !names.has(m.senderId)) void nameOf(m.senderId).then(() => renderMessages(conv));
  return li;
}

// Attachments: links are short-lived, so fetch one when rendering (cached for 4 minutes).
const links = new Map();
function attachmentEl(a) {
  const isImage = a.mimeType.startsWith("image/");
  const node = isImage ? el("img", "file") : el("a", "file");
  if (isImage) node.alt = a.name;
  else node.append(icon("file", 18), el("span", "", `${a.name} · ${Math.ceil(a.size / 1024)} KB`));
  const hit = links.get(a.id);
  const apply = (url) => (isImage ? (node.src = url) : ((node.href = url), (node.target = "_blank"), (node.rel = "noopener")));
  if (hit && hit.until > Date.now()) apply(hit.url);
  else
    chat.attachments.url(a.id, 300).then(({ url }) => {
      links.set(a.id, { url, until: Date.now() + 240_000 });
      apply(url);
    }, toast);
  return node;
}

$("file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !current) return;
  const status = $("upload");
  status.hidden = false;
  $("upload-text").textContent = `Uploading ${file.name}…`;
  try {
    const att = await current.upload(file, { onProgress: (p) => ($("upload-text").textContent = `Uploading ${file.name}… ${Math.round(p * 100)}%`) });
    await current.send({ text: $("text").value.trim() || undefined, attachments: [att] });
    $("text").value = "";
    resizeComposer();
  } catch (err) {
    toast(err); // e.g. storage_unavailable when no media storage is configured
  } finally {
    status.hidden = true;
  }
});

$("older").addEventListener("click", async () => {
  if (!current) return;
  const s = $("scroller");
  const fromBottom = s.scrollHeight - s.scrollTop;
  try {
    const { hasMore } = await current.loadOlder({ limit: 30 });
    s.scrollTop = s.scrollHeight - fromBottom; // keep the reading position
    if (!hasMore) $("older").hidden = true;
  } catch (err) {
    toast(err); // HistoryUnavailableError when the customer DB is down
  }
});

// ------------------------------------------------------------------ composer

function resizeComposer() {
  const t = $("text");
  t.style.height = "auto";
  t.style.height = `${Math.min(t.scrollHeight, 160)}px`;
  $("send").disabled = !t.value.trim();
}

$("text").addEventListener("input", () => {
  resizeComposer();
  current?.typing();
});
$("text").addEventListener("blur", () => current?.stopTyping());
// Enter sends, Shift+Enter adds a line.
$("text").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    $("composer").requestSubmit();
  }
});

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("text");
  const text = input.value.trim();
  if (!text || !current) return;
  input.value = "";
  resizeComposer();
  current.stopTyping();
  scrollToBottom();
  try {
    await current.send({ text }); // resolves on ack; stays "sending" while offline and retries
  } catch (err) {
    toast(err);
  }
});

// Resume the last session in this tab.
const saved = sessionStorage.getItem("byotalk-example-user");
if (saved) {
  me = JSON.parse(saved);
  fetchToken(me.id, me.name).then(start, (err) => ($("login-error").textContent = errText(err)));
}
