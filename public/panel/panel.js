const params = new URLSearchParams(location.search);
const WORKER_API = "https://twitch-loyalty.damir-cy.workers.dev/api";

function defaultApiBase() {
  const host = location.hostname;
  // Hosted Test / Released: files come from Twitch CDN, API stays on the Worker.
  if (host.endsWith("ext-twitch.tv") || host.endsWith(".twitch.tv")) {
    return WORKER_API;
  }
  return `${location.origin}/api`;
}

const API_BASE =
  params.get("api") ||
  localStorage.getItem("loyaltyApiBase") ||
  defaultApiBase();

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
  shareIdentity: document.querySelector("#share-identity"),
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
        : err?.data?.error === "cooldown"
          ? "Too fast — wait a second"
          : err.message;
    setStatus(msg, "err");
  } finally {
    els.redeemConfirm.disabled = false;
  }
}

function sessionBody() {
  return JSON.stringify({
    helixToken: helixToken || undefined,
    clientId: twitchClientId || undefined,
  });
}

function twitchViewerLinked() {
  return Boolean(window.Twitch?.ext?.viewer?.isLinked);
}

function updateShareButton() {
  if (!els.shareIdentity) return;
  const show = authMode === "twitch" && !twitchViewerLinked();
  els.shareIdentity.classList.toggle("hidden", !show);
}

async function resolveTwitchName() {
  const viewer = window.Twitch?.ext?.viewer;
  if (!viewer?.isLinked || !viewer.id || !helixToken || !twitchClientId) {
    updateShareButton();
    return;
  }
  updateShareButton();
  if (twitchDisplayName) return;
  const url = `https://api.twitch.tv/helix/users?id=${encodeURIComponent(viewer.id)}`;
  for (const scheme of ["Extension", "Bearer"]) {
    try {
      const res = await fetch(url, {
        headers: {
          "Client-Id": twitchClientId,
          Authorization: `${scheme} ${helixToken}`,
        },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const name = data.data?.[0]?.display_name;
      if (typeof name === "string" && name.trim()) {
        twitchDisplayName = name.trim();
        return;
      }
    } catch {
      // try the other scheme
    }
  }
}

function requestIdentityShare() {
  window.Twitch?.ext?.actions?.requestIdShare?.();
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
  updateShareButton();
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
els.shareIdentity?.addEventListener("click", requestIdentityShare);
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
    void resolveTwitchName().then(() => {
      if (!sessionStarted) begin("twitch");
      else if (twitchDisplayName) void beat();
    });
  });

  window.Twitch.ext.viewer?.onChanged?.(() => {
    void resolveTwitchName().then(() => {
      if (sessionStarted && twitchDisplayName) void beat();
    });
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
