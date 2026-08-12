const params = new URLSearchParams(location.search);
const API_BASE =
  params.get("api") || `${location.origin.replace(/\/$/, "")}/api`;
const WS_BASE =
  params.get("ws") ||
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

let channelId = params.get("channel") || "";
/** @type {WebSocket | null} */
let socket = null;

const els = {
  watching: document.querySelector("#watching"),
  leaderboard: document.querySelector("#leaderboard"),
  feed: document.querySelector("#feed"),
  room: document.querySelector("#room"),
};

function render(state) {
  if (state.channelId && state.channelId !== channelId) {
    channelId = state.channelId;
    connectWs();
  }
  if (els.room) {
    els.room.textContent = channelId
      ? `Room ${channelId}`
      : "Waiting for Extension viewers…";
  }
  renderPeople(els.watching, state.watching || [], "Nobody watching yet");
  renderPeople(els.leaderboard, state.leaderboard || [], "No points yet", true);
  renderFeed(state.recent || []);
}

function renderPeople(root, people, emptyText, showPoints = true) {
  root.innerHTML = "";
  if (!people.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = emptyText;
    root.appendChild(li);
    return;
  }
  for (const person of people.slice(0, 8)) {
    const li = document.createElement("li");
    li.innerHTML = showPoints
      ? `${escapeHtml(person.displayName)} <span class="points">${person.points}</span>`
      : escapeHtml(person.displayName);
    root.appendChild(li);
  }
}

function renderFeed(events) {
  els.feed.innerHTML = "";
  if (!events.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Waiting for activity…";
    els.feed.appendChild(li);
    return;
  }
  for (const event of events.slice(0, 6)) {
    const li = document.createElement("li");
    li.textContent = event.message;
    els.feed.appendChild(li);
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function wsUrl() {
  if (!channelId) return WS_BASE;
  const url = new URL(WS_BASE, location.href);
  url.searchParams.set("channel", channelId);
  return url.toString();
}

function connectWs() {
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  const ws = new WebSocket(wsUrl());
  socket = ws;
  ws.addEventListener("message", (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === "overlay") render({ ...msg.data, channelId });
    } catch {
      // ignore malformed
    }
  });
  ws.addEventListener("close", () => {
    if (socket === ws) setTimeout(connectWs, 1500);
  });
}

async function pollOnce() {
  try {
    const url = channelId
      ? `${API_BASE}/overlay?channel=${encodeURIComponent(channelId)}`
      : `${API_BASE}/overlay`;
    const res = await fetch(url);
    if (res.ok) render(await res.json());
  } catch {
    // overlay stays on last frame
  }
}

void pollOnce();
connectWs();
setInterval(() => void pollOnce(), 4000);
