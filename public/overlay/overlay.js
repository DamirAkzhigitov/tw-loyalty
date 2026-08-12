const params = new URLSearchParams(location.search);
const API_BASE =
  params.get("api") || `${location.origin.replace(/\/$/, "")}/api`;
const WS_BASE =
  params.get("ws") ||
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;

let channelId = params.get("channel") || "";
/** @type {WebSocket | null} */
let socket = null;

const scale = Number(params.get("scale") || "1");
if (Number.isFinite(scale) && scale > 0 && scale !== 1) {
  document.documentElement.style.zoom = String(scale);
}

const els = {
  watching: document.querySelector("#watching"),
  leaderboard: document.querySelector("#leaderboard"),
  feed: document.querySelector("#feed"),
  room: document.querySelector("#room"),
  cardWatching: document.querySelector("#card-watching"),
  cardBoard: document.querySelector("#card-board"),
  cardFeed: document.querySelector("#card-feed"),
};

if (params.get("debug") === "1" && els.room) {
  els.room.classList.add("debug");
}

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
  renderPeople(
    els.watching,
    els.cardWatching,
    state.watching || [],
    true,
    5,
  );
  renderPeople(
    els.leaderboard,
    els.cardBoard,
    state.leaderboard || [],
    true,
    5,
  );
  renderFeed(state.recent || []);
}

function renderPeople(root, card, people, showPoints, limit) {
  root.innerHTML = "";
  if (!people.length) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  for (const person of people.slice(0, limit)) {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = person.displayName;
    li.appendChild(name);
    if (showPoints) {
      const pts = document.createElement("span");
      pts.className = "points";
      pts.textContent = String(person.points);
      li.appendChild(pts);
    }
    root.appendChild(li);
  }
}

function renderFeed(events) {
  els.feed.innerHTML = "";
  if (!events.length) {
    els.cardFeed.classList.add("hidden");
    return;
  }
  els.cardFeed.classList.remove("hidden");
  for (const event of events.slice(0, 4)) {
    const li = document.createElement("li");
    li.textContent = event.message;
    els.feed.appendChild(li);
  }
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

function isLocalHost() {
  return location.hostname === "127.0.0.1" || location.hostname === "localhost";
}

/** OBS caches CSS hard. On localhost, reload when overlay files change. */
async function startLiveReload() {
  if (!isLocalHost() || params.get("live") === "0") return;
  const files = ["./index.html", "./overlay.css", "./overlay.js"];
  const peek = async () => {
    const parts = await Promise.all(
      files.map((file) =>
        fetch(`${file}?lr=${Date.now()}`, { cache: "no-store" }).then((res) =>
          res.ok ? res.text() : "",
        ),
      ),
    );
    return parts.join("\n--\n");
  };
  let stamp = await peek();
  setInterval(() => {
    void peek()
      .then((next) => {
        if (next && next !== stamp) location.reload();
      })
      .catch(() => {
        // wrangler restarting
      });
  }, 800);
}

void startLiveReload();
