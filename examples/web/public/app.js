// Example chat client built on the `byotalk` SDK (served from ../../dist as /sdk/index.js).
// All user content is rendered with textContent, never innerHTML.
import { Chat, localStoragePersistence } from "/sdk/index.js";

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};
const time = (iso) => new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const showError = (target, err) => {
  target.textContent = err ? `${err.message ?? err}${err.code ? ` (${err.code})` : ""}${err.requestId ? ` · ${err.requestId}` : ""}` : "";
};

let chat = null;
let me = null;
let current = null; // open Conversation
let stopCurrent = [];
const labels = new Map(); // conversation id → display title
const names = new Map(); // user id → display name

// ------------------------------------------------------------------ sign in

async function fetchToken(userId, name) {
  const res = await fetch(`/api/token?userId=${encodeURIComponent(userId)}&name=${encodeURIComponent(name)}`);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const form = new FormData(e.target);
  const userId = form.get("userId").trim();
  const name = form.get("name").trim() || userId;
  showError($("login-error"));
  try {
    const first = await fetchToken(userId, name);
    me = { id: userId, name };
    sessionStorage.setItem("byotalk-example-user", JSON.stringify(me));
    await start(first);
  } catch (err) {
    showError($("login-error"), err);
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
    const b = $("conn");
    b.textContent = s;
    b.dataset.state = s;
  });
  chat.on("error", (err) => showError($("chat-error"), err));

  $("login").hidden = true;
  $("app").hidden = false;
  $("me-name").textContent = `${me.name} (${me.id})`;
  await chat.connect();
  chat.conversations.watch(renderConversations);
}

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

async function labelFor(summary) {
  if (summary.name) return summary.name;
  if (labels.has(summary.id)) return labels.get(summary.id);
  const members = await chat.rest.request("GET", `/v1/conversations/${summary.id}/members`);
  const other = members.data.find((m) => m.userId !== me.id)?.userId ?? me.id;
  const label = await nameOf(other);
  labels.set(summary.id, label);
  return label;
}

async function renderConversations(list) {
  const ul = $("conversations");
  const items = await Promise.all(
    list.map(async (c) => {
      const li = el("li", c.id === current?.id ? "active" : "");
      const btn = el("button", "conv");
      btn.append(el("span", "conv-title", await labelFor(c)));
      if (c.unreadCount > 0 && c.id !== current?.id) btn.append(el("span", "unread", String(c.unreadCount)));
      const last = c.lastMessage;
      btn.append(el("span", "conv-last muted", last ? (last.deletedAt ? "Message deleted" : (last.text ?? "Attachment")) : "No messages yet"));
      btn.addEventListener("click", () => open(c.id));
      li.append(btn);
      return li;
    }),
  );
  ul.replaceChildren(...items);
}

$("new-dm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = e.target.elements.userId;
  try {
    const conv = await chat.conversations.direct(input.value.trim());
    input.value = "";
    await open(conv.id);
  } catch (err) {
    showError($("chat-error"), err);
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
    await open(conv.id);
  } catch (err) {
    showError($("chat-error"), err);
  }
});

// ------------------------------------------------------------------ open conversation

async function open(id) {
  for (const stop of stopCurrent) stop();
  stopCurrent = [];
  showError($("chat-error"));
  current = await chat.conversations.get(id);
  const conv = current;
  $("empty").hidden = true;
  $("chat").hidden = false;
  $("title").textContent = conv.name ?? (await labelFor({ id: conv.id, name: null }));
  $("typing").textContent = "";

  stopCurrent.push(conv.messages.subscribe(() => renderMessages(conv)));
  stopCurrent.push(conv.on("receipt", () => renderMessages(conv)));
  stopCurrent.push(
    conv.on("typing", async (ids) => {
      const who = await Promise.all(ids.map(nameOf));
      $("typing").textContent = who.length ? `${who.join(", ")} ${who.length > 1 ? "are" : "is"} typing…` : "";
    }),
  );
  stopCurrent.push(conv.on("message.new", (m) => m.senderId !== me.id && conv.markRead().catch(() => {})));
  stopCurrent.push(conv.on("removed", () => location.reload()));

  // Presence for direct chats.
  const others = conv.members.filter((m) => m.userId !== me.id).map((m) => m.userId);
  if (conv.type === "direct" && others.length) {
    stopCurrent.push(
      chat.presence.watch(others, (p) => {
        $("presence").textContent = p.online ? "online" : p.lastSeenAt ? `last seen ${time(p.lastSeenAt)}` : "offline";
      }),
    );
  } else {
    $("presence").textContent = `${conv.members.length} members`;
  }
  await conv.markRead().catch(() => {});
  $("text").focus();
}

function renderMessages(conv) {
  if (conv !== current) return;
  const ol = $("messages");
  const atBottom = ol.scrollHeight - ol.scrollTop - ol.clientHeight < 40;
  const items = conv.messages.items.map((m) => {
    const mine = m.senderId === me.id;
    const li = el("li", `msg ${mine ? "mine" : ""} ${m.status}`);
    if (!mine && conv.type === "group") li.append(el("span", "sender", names.get(m.senderId) ?? m.senderId));
    if (m.deletedAt || m.text) li.append(el("p", m.deletedAt ? "text deleted" : "text", m.deletedAt ? "Message deleted" : m.text));
    if (!m.deletedAt) for (const a of m.attachments) li.append(attachmentEl(a));
    const meta = el("span", "meta muted");
    meta.append(m.status === "sent" ? time(m.createdAt) : m.status);
    if (m.editedAt && !m.deletedAt) meta.append(" · edited");
    if (mine && m.seq !== null && !m.deletedAt) meta.append(conv.readBy(m.seq).length ? " · ✓✓ read" : " · ✓");
    li.append(meta);
    if (m.status === "failed") {
      const retry = el("button", "link", "Retry");
      retry.addEventListener("click", () => conv.retry(m.clientMsgId).catch((err) => showError($("chat-error"), err)));
      li.append(retry);
    }
    if (mine && m.id && !m.deletedAt) {
      const actions = el("span", "actions");
      const edit = el("button", "link", "Edit");
      edit.addEventListener("click", async () => {
        const text = prompt("Edit message", m.text ?? "");
        if (text !== null && text.trim()) await conv.edit(m.id, { text: text.trim() }).catch((err) => showError($("chat-error"), err));
      });
      const del = el("button", "link", "Delete");
      del.addEventListener("click", () => conv.delete(m.id).catch((err) => showError($("chat-error"), err)));
      actions.append(edit, del);
      li.append(actions);
    }
    if (!mine) void nameOf(m.senderId);
    return li;
  });
  ol.replaceChildren(...items);
  if (atBottom) ol.scrollTop = ol.scrollHeight;
}

// Attachments: links are short-lived, so fetch one when rendering (cached for 4 minutes).
const links = new Map();
function attachmentEl(a) {
  const isImage = a.mimeType.startsWith("image/");
  const node = isImage ? el("img", "file") : el("a", "file", `📄 ${a.name} (${Math.ceil(a.size / 1024)} KB)`);
  if (isImage) node.alt = a.name;
  const hit = links.get(a.id);
  const apply = (url) => (isImage ? (node.src = url) : ((node.href = url), (node.target = "_blank")));
  if (hit && hit.until > Date.now()) apply(hit.url);
  else
    chat.attachments.url(a.id, 300).then(
      ({ url }) => {
        links.set(a.id, { url, until: Date.now() + 240_000 });
        apply(url);
      },
      (err) => showError($("chat-error"), err),
    );
  return node;
}

$("file").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = "";
  if (!file || !current) return;
  const status = $("upload");
  status.hidden = false;
  status.textContent = `Uploading ${file.name}…`;
  try {
    const att = await current.upload(file, { onProgress: (p) => (status.textContent = `Uploading ${file.name}… ${Math.round(p * 100)}%`) });
    await current.send({ text: $("text").value.trim() || undefined, attachments: [att] });
    $("text").value = "";
    status.hidden = true;
  } catch (err) {
    status.hidden = true;
    showError($("chat-error"), err); // e.g. storage_unavailable when no media storage is configured
  }
});

$("older").addEventListener("click", async () => {
  if (!current) return;
  try {
    const { hasMore } = await current.loadOlder({ limit: 30 });
    if (!hasMore) $("older").textContent = "Beginning of the conversation";
  } catch (err) {
    showError($("chat-error"), err); // HistoryUnavailableError when the customer DB is down
  }
});

$("text").addEventListener("input", () => current?.typing());
$("text").addEventListener("blur", () => current?.stopTyping());

$("composer").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("text");
  const text = input.value.trim();
  if (!text || !current) return;
  input.value = "";
  const ol = $("messages");
  ol.scrollTop = ol.scrollHeight;
  try {
    await current.send({ text }); // resolves on ack; stays "sending" while offline and retries
  } catch (err) {
    showError($("chat-error"), err);
  }
});

// Resume the last session in this tab.
const saved = sessionStorage.getItem("byotalk-example-user");
if (saved) {
  me = JSON.parse(saved);
  fetchToken(me.id, me.name).then(start, (err) => showError($("login-error"), err));
}
