const params = new URLSearchParams(location.search);
const API_BASE =
  params.get("api") || `${location.origin.replace(/\/$/, "")}/api`;
const WS_BASE =
  params.get("ws") ||
  `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`;
const ENABLE_TTS = params.get("tts") === "1";

let channelId = params.get("channel") || "";
/** @type {WebSocket | null} */
let socket = null;
/** @type {string | null} */
let lastAlertKey = null;
/** @type {string | null} */
let lastWheelSpinId = null;

const scale = Number(params.get("scale") || "1");
if (Number.isFinite(scale) && scale > 0 && scale !== 1) {
  document.documentElement.style.zoom = String(scale);
}

if (params.get("layout") === "compact") {
  document.body.classList.add("layout-compact");
}

const els = {
  watching: document.querySelector("#watching"),
  leaderboard: document.querySelector("#leaderboard"),
  feed: document.querySelector("#feed"),
  room: document.querySelector("#room"),
  cardWatching: document.querySelector("#card-watching"),
  cardBoard: document.querySelector("#card-board"),
  cardFeed: document.querySelector("#card-feed"),
  cardPoll: document.querySelector("#card-poll"),
  cardNow: document.querySelector("#card-now"),
  pollQuestion: document.querySelector("#poll-question"),
  pollOptions: document.querySelector("#poll-options"),
  nowPlaying: document.querySelector("#now-playing"),
  alert: document.querySelector("#alert"),
  alertKicker: document.querySelector("#alert-kicker"),
  alertName: document.querySelector("#alert-name"),
  alertText: document.querySelector("#alert-text"),
  wheelStage: document.querySelector("#wheel-stage"),
  wheel: document.querySelector("#wheel"),
  wheelResult: document.querySelector("#wheel-result"),
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
  renderAlert(state.activeAlert);
  renderWheel(state.activeAlert);
  renderPoll(state.activePoll);
  renderNowPlaying(state.nowPlaying, state.activeAlert);
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

function renderNowPlaying(nowPlaying, activeAlert) {
  const song =
    (activeAlert?.kind === "song" && activeAlert) ||
    (nowPlaying?.type === "song" && nowPlaying);
  if (!song) {
    els.cardNow.classList.add("hidden");
    return;
  }
  els.cardNow.classList.remove("hidden");
  const title =
    activeAlert?.title ||
    activeAlert?.text ||
    nowPlaying?.payload?.text ||
    "Song request";
  const who = activeAlert?.displayName || nowPlaying?.displayName || "";
  els.nowPlaying.textContent = who ? `${title} · ${who}` : title;
}

function renderPoll(poll) {
  if (!poll) {
    els.cardPoll.classList.add("hidden");
    return;
  }
  els.cardPoll.classList.remove("hidden");
  const suffix = poll.status === "closed" ? " (final)" : "";
  els.pollQuestion.textContent = `${poll.question}${suffix}`;
  const total = Math.max(1, poll.totalVotes || 0);
  els.pollOptions.innerHTML = "";
  for (const option of poll.options || []) {
    const li = document.createElement("li");
    const pct = Math.round(((option.votes || 0) / total) * 100);
    li.innerHTML = `<span>${option.label} · ${option.votes || 0}</span><div class="poll-bar"><span style="width:${pct}%"></span></div>`;
    els.pollOptions.appendChild(li);
  }
}

function renderAlert(alert) {
  if (!alert || alert.kind === "wheel") {
    if (!alert) {
      els.alert.classList.add("hidden");
      lastAlertKey = null;
    }
    if (alert?.kind === "wheel") {
      els.alert.classList.add("hidden");
    }
    return;
  }

  const key = `${alert.redeemId}:${alert.startedAt}`;
  const isNew = key !== lastAlertKey;
  lastAlertKey = key;

  els.alert.classList.remove("hidden");
  els.alert.className = `alert kind-${alert.kind}`;
  const kickers = {
    shoutout: "Shoutout",
    tts: "Voice message",
    song: "Now playing",
  };
  els.alertKicker.textContent = kickers[alert.kind] || "Redeem";
  els.alertName.textContent = alert.displayName || "";
  els.alertText.textContent = alert.text || alert.title || "";

  if (isNew && alert.kind === "tts" && ENABLE_TTS && alert.text) {
    trySpeak(alert.text);
  }
}

function renderWheel(alert) {
  if (!alert || alert.kind !== "wheel") {
    els.wheelStage.classList.add("hidden");
    return;
  }

  els.wheelStage.classList.remove("hidden");
  const segments = alert.segments || [];
  if (segments.length) {
    const colors = segments.map(
      (s, i) => s.color || ["#12b5a7", "#ff5d4a", "#2f9ed8", "#e8a317", "#8b9bb4", "#d61f3a"][i % 6],
    );
    const step = 100 / segments.length;
    const stops = colors
      .map((c, i) => `${c} ${i * step}% ${(i + 1) * step}%`)
      .join(", ");
    els.wheel.style.background = `conic-gradient(${stops})`;
  }

  const spinId = `${alert.redeemId}:${alert.startedAt}`;
  const index = Number(alert.segmentIndex) || 0;
  const count = Math.max(1, segments.length || 6);
  const segmentAngle = 360 / count;
  // Pointer is at top; rotate so winning segment center lands under pointer.
  const target =
    360 * 5 + (360 - (index * segmentAngle + segmentAngle / 2));

  if (spinId !== lastWheelSpinId) {
    lastWheelSpinId = spinId;
    els.wheel.style.transition = "none";
    els.wheel.style.transform = "rotate(0deg)";
    els.wheelResult.textContent = `${alert.displayName} is spinning…`;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const ms = alert.spinMs || 6500;
        els.wheel.style.transition = `transform ${ms}ms cubic-bezier(0.12, 0.75, 0.12, 1)`;
        els.wheel.style.transform = `rotate(${target}deg)`;
        setTimeout(() => {
          els.wheelResult.textContent = alert.text
            ? `${alert.displayName}: ${alert.text}`
            : `${alert.displayName} landed!`;
        }, ms);
      });
    });
  } else if (Date.now() - (alert.startedAt || 0) > (alert.spinMs || 6500)) {
    els.wheelResult.textContent = alert.text
      ? `${alert.displayName}: ${alert.text}`
      : `${alert.displayName} landed!`;
    els.wheel.style.transform = `rotate(${target}deg)`;
  }
}

function trySpeak(text) {
  if (!window.speechSynthesis) return;
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(text);
  utter.rate = 1;
  window.speechSynthesis.speak(utter);
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
