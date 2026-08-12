const params = new URLSearchParams(location.search);
const API_BASE =
  params.get("api") ||
  localStorage.getItem("loyaltyApiBase") ||
  `${location.origin}/api`;

const DEV_USER =
  params.get("user") || localStorage.getItem("loyaltyDevUser") || "dev-viewer-1";
const DEV_NAME =
  params.get("name") || localStorage.getItem("loyaltyDevName") || "DevViewer";

/** @type {string | null} */
let authToken = null;
/** @type {string | null} */
let helixToken = null;
/** @type {string | null} */
let twitchClientId = null;
/** @type {string | null} */
let twitchDisplayName = null;
/** @type {'twitch' | 'dev'} */
let authMode = "dev";
let sessionStarted = false;
/** @type {number} */
let tickMs = 1000;
/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimer = null;
/** @type {{ id: string, cost: number, needsText: boolean, label: string } | null} */
let pendingReward = null;

const els = {
  displayName: document.querySelector("#display-name"),
  points: document.querySelector("#points"),
  status: document.querySelector("#status"),
  rewards: document.querySelector("#rewards"),
  form: document.querySelector("#redeem-form"),
  redeemLabel: document.querySelector("#redeem-label"),
  redeemText: document.querySelector("#redeem-text"),
  redeemCancel: document.querySelector("#redeem-cancel"),
  redeemConfirm: document.querySelector("#redeem-confirm"),
};

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function authHeaders() {
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if (authMode === "twitch" && authToken) {
    headers.Authorization = `Bearer ${authToken}`;
    if (twitchDisplayName) headers["X-Viewer-Name"] = twitchDisplayName;
  } else {
    headers["X-Dev-User-Id"] = DEV_USER;
    headers["X-Dev-Display-Name"] = DEV_NAME;
  }
  return headers;
}

async function api(path, options = {}) {
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      ...authHeaders(),
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `http_${res.status}`);
    err.data = data;
    err.status = res.status;
    throw err;
  }
  return data;
}

function renderViewer(viewer) {
  if (!viewer) return;
  els.displayName.textContent = viewer.displayName;
  els.points.textContent = String(viewer.points);
}

function renderRewards(rewards) {
  els.rewards.innerHTML = "";
  for (const reward of rewards) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reward";
    btn.innerHTML = `
      <div class="reward-title">
        <span>${escapeHtml(reward.label)}</span>
        <span class="reward-cost">${reward.cost} pts</span>
      </div>
      <div class="reward-desc">${escapeHtml(reward.description)}</div>
    `;
    btn.addEventListener("click", () => openRedeem(reward));
    els.rewards.appendChild(btn);
  }
}

function openRedeem(reward) {
  pendingReward = reward;
  if (reward.needsText) {
    els.form.classList.remove("hidden");
    els.redeemLabel.textContent =
      reward.id === "song" ? "Song / link" : "Message";
    els.redeemText.value = "";
    els.redeemText.focus();
  } else {
    void submitRedeem("");
  }
}

function closeRedeem() {
  pendingReward = null;
  els.form.classList.add("hidden");
  els.redeemText.value = "";
}

async function submitRedeem(text) {
  if (!pendingReward) return;
  els.redeemConfirm.disabled = true;
  try {
    const result = await api("/viewer/redeem", {
      method: "POST",
      body: JSON.stringify({ type: pendingReward.id, text }),
    });
    renderViewer(result.viewer);
    setStatus(`Queued: ${pendingReward.label}`, "ok");
    closeRedeem();
  } catch (err) {
    const msg =
      err?.data?.error === "insufficient_points"
        ? "Not enough points"
        : err.message;
    setStatus(msg, "err");
  } finally {
    els.redeemConfirm.disabled = false;
  }
}

function sessionBody() {
  return JSON.stringify({
    displayName: twitchDisplayName || undefined,
    helixToken: helixToken || undefined,
    clientId: twitchClientId || undefined,
  });
}

async function startSession() {
  const data = await api("/viewer/session", {
    method: "POST",
    body: sessionBody(),
  });
  renderViewer(data.viewer);
  renderRewards(data.rewards || []);
  if (data.config?.tickMs) tickMs = data.config.tickMs;
  setStatus(
    authMode === "twitch" ? "Watching · earning points" : "Dev mode · earning points",
    "ok",
  );
  startHeartbeat();
}

async function beat() {
  try {
    const data = await api("/viewer/heartbeat", {
      method: "POST",
      body: sessionBody(),
    });
    renderViewer(data.viewer);
  } catch (err) {
    setStatus(`Heartbeat failed: ${err.message}`, "err");
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    void beat();
  }, tickMs);
  void beat();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

els.redeemCancel.addEventListener("click", closeRedeem);
els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  void submitRedeem(els.redeemText.value.trim());
});

function begin(mode) {
  if (sessionStarted) return;
  sessionStarted = true;
  authMode = mode;
  void startSession().catch((err) =>
    setStatus(`Failed to start: ${err.message}`, "err"),
  );
}

function bootTwitch() {
  if (!window.Twitch?.ext) {
    begin("dev");
    return;
  }

  window.Twitch.ext.onAuthorized((auth) => {
    authToken = auth.token;
    helixToken = auth.helixToken || null;
    twitchClientId = auth.clientId || null;
    begin("twitch");
  });

  // Only the standalone /panel page needs a DevViewer fallback.
  // The Twitch Extension always runs in an iframe and waits for onAuthorized.
  if (window === window.top) {
    setTimeout(() => {
      if (!sessionStarted) begin("dev");
    }, 2000);
  }
}

bootTwitch();
