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
const DEV_CHANNEL =
  params.get("channel") || localStorage.getItem("loyaltyDevChannel") || "";

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
/** @type {number} */
let pointsPerTick = 1;
/** @type {ReturnType<typeof setInterval> | null} */
let heartbeatTimer = null;
/** @type {{ id: string, cost: number, needsText: boolean, label: string, maxLength?: number } | null} */
let pendingReward = null;
/** @type {Array<{ id: string, cost: number, needsText: boolean, label: string, description?: string, maxLength?: number }>} */
let rewardsCatalog = [];
/** @type {{ points: number, displayName?: string } | null} */
let currentViewer = null;
/** @type {null | { id: string, question: string, options: Array<{id:string,label:string,votes:number}>, status: string, endsAt?: number }} */
let activePoll = null;
/** @type {string | null} */
let myVoteOptionId = null;
/** @type {number} */
let wheelCooldownMs = 0;

const els = {
  displayName: document.querySelector("#display-name"),
  points: document.querySelector("#points"),
  status: document.querySelector("#status"),
  earnRate: document.querySelector("#earn-rate"),
  rewards: document.querySelector("#rewards"),
  form: document.querySelector("#redeem-form"),
  redeemLabel: document.querySelector("#redeem-label"),
  redeemText: document.querySelector("#redeem-text"),
  redeemCancel: document.querySelector("#redeem-cancel"),
  redeemConfirm: document.querySelector("#redeem-confirm"),
  shareIdentity: document.querySelector("#share-identity"),
  pollSection: document.querySelector("#poll-section"),
  pollTitle: document.querySelector("#poll-title"),
  pollOptions: document.querySelector("#poll-options"),
  pollHint: document.querySelector("#poll-hint"),
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
    if (DEV_CHANNEL) headers["X-Dev-Channel-Id"] = DEV_CHANNEL;
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

function formatEarnRate() {
  if (!els.earnRate) return;
  const perSec = pointsPerTick / Math.max(tickMs / 1000, 0.001);
  const label =
    perSec >= 0.95
      ? `+${pointsPerTick} / sec while this panel is open`
      : `+${pointsPerTick} every ${Math.round(tickMs / 1000)}s while this panel is open`;
  els.earnRate.textContent = label;
}

function renderViewer(viewer) {
  if (!viewer) return;
  currentViewer = viewer;
  els.displayName.textContent = viewer.displayName;
  els.points.textContent = String(viewer.points);
  renderRewards(rewardsCatalog);
}

function renderRewards(rewards) {
  rewardsCatalog = rewards || rewardsCatalog;
  els.rewards.innerHTML = "";
  const points = currentViewer?.points ?? 0;

  for (const reward of rewardsCatalog) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reward";
    const need = Math.max(0, reward.cost - points);
    const onCooldown = reward.id === "wheel" && wheelCooldownMs > 0;
    const unaffordable = points < reward.cost;
    btn.disabled = unaffordable || onCooldown;

    let extra = escapeHtml(reward.description || "");
    if (onCooldown) {
      extra = `Ready in ${formatMs(wheelCooldownMs)}`;
      btn.classList.add("need-more");
    } else if (unaffordable) {
      extra = `Need ${need} more`;
      btn.classList.add("need-more");
    }

    btn.innerHTML = `
      <div class="reward-title">
        <span>${escapeHtml(reward.label)}</span>
        <span class="reward-cost">${reward.cost} pts</span>
      </div>
      <div class="reward-desc">${extra}</div>
    `;
    btn.addEventListener("click", () => openRedeem(reward));
    els.rewards.appendChild(btn);
  }
}

function formatMs(ms) {
  const sec = Math.ceil(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

function openRedeem(reward) {
  pendingReward = reward;
  if (reward.needsText) {
    els.form.classList.remove("hidden");
    els.redeemLabel.textContent =
      reward.id === "song" ? "Song / link" : "Message";
    els.redeemText.value = "";
    if (reward.maxLength) els.redeemText.maxLength = reward.maxLength;
    els.redeemConfirm.textContent = `Confirm · ${reward.cost}`;
    els.redeemText.focus();
  } else {
    void submitRedeem("");
  }
}

function closeRedeem() {
  pendingReward = null;
  els.form.classList.add("hidden");
  els.redeemText.value = "";
  els.redeemConfirm.textContent = "Confirm";
}

function statusForRedeem(event, label) {
  if (!event) return `Queued: ${label}`;
  if (event.status === "playing") return `Playing now: ${label}`;
  if (event.status === "rejected") {
    return event.refunded ? `Rejected · refunded` : `Rejected: ${label}`;
  }
  if (event.status === "done") return `Done: ${label}`;
  return `Queued: ${label}`;
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
    if (typeof result.wheelCooldownMs === "number") {
      wheelCooldownMs = result.wheelCooldownMs;
    }
    if (result.activePoll) renderPoll(result.activePoll);
    setStatus(statusForRedeem(result.event, pendingReward.label), "ok");
    closeRedeem();
    renderRewards(rewardsCatalog);
  } catch (err) {
    const code = err?.data?.error;
    const msg =
      code === "insufficient_points"
        ? "Not enough points"
        : code === "cooldown"
          ? `Cooldown ${formatMs(err.data.cooldownMs || 0)}`
          : err.message;
    setStatus(msg, "err");
  } finally {
    els.redeemConfirm.disabled = false;
  }
}

function renderPoll(poll) {
  activePoll = poll;
  if (!poll) {
    els.pollSection.classList.add("hidden");
    return;
  }
  if (poll.status === "closed" && poll.endsAt && Date.now() >= poll.endsAt) {
    els.pollSection.classList.add("hidden");
    return;
  }

  els.pollSection.classList.remove("hidden");
  els.pollTitle.textContent =
    poll.status === "closed" ? `${poll.question} (final)` : poll.question;
  els.pollOptions.innerHTML = "";

  for (const option of poll.options || []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "poll-option";
    if (myVoteOptionId === option.id) btn.classList.add("selected");
    btn.disabled = poll.status !== "open" || Boolean(myVoteOptionId);
    btn.textContent = `${option.label} · ${option.votes || 0}`;
    btn.addEventListener("click", () => void castVote(option.id));
    els.pollOptions.appendChild(btn);
  }

  if (poll.status === "closed") {
    els.pollHint.textContent = "Poll closed";
  } else if (myVoteOptionId) {
    els.pollHint.textContent = "Vote locked in";
  } else {
    const left = poll.endsAt ? Math.max(0, poll.endsAt - Date.now()) : 0;
    els.pollHint.textContent = left
      ? `Tap once to vote · ${formatMs(left)} left`
      : "Tap once to vote";
  }
}

async function castVote(optionId) {
  try {
    const result = await api("/viewer/vote", {
      method: "POST",
      body: JSON.stringify({ optionId }),
    });
    myVoteOptionId = optionId;
    if (result.viewer) renderViewer(result.viewer);
    renderPoll(result.poll);
    setStatus("Vote counted", "ok");
  } catch (err) {
    if (err?.data?.error === "already_voted") {
      myVoteOptionId = optionId;
      renderPoll(err.data.poll || activePoll);
      setStatus("Already voted", "ok");
      return;
    }
    setStatus(err.message, "err");
  }
}

function sessionBody() {
  const twitchUserId = window.Twitch?.ext?.viewer?.id || undefined;
  return JSON.stringify({
    displayName: twitchDisplayName || undefined,
    helixToken: helixToken || undefined,
    clientId: twitchClientId || undefined,
    twitchUserId,
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
  if (data.config?.tickMs) tickMs = data.config.tickMs;
  if (data.config?.pointsPerTick) pointsPerTick = data.config.pointsPerTick;
  formatEarnRate();
  rewardsCatalog = data.rewards || [];
  renderViewer(data.viewer);
  if (typeof data.wheelCooldownMs === "number") {
    wheelCooldownMs = data.wheelCooldownMs;
  }
  myVoteOptionId = null;
  renderPoll(data.activePoll);
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
    if (typeof data.wheelCooldownMs === "number") {
      wheelCooldownMs = data.wheelCooldownMs;
      renderRewards(rewardsCatalog);
    }
    if (data.activePoll) {
      // Preserve local vote selection across heartbeats
      renderPoll(data.activePoll);
    } else {
      myVoteOptionId = null;
      renderPoll(null);
    }
    if (data.lastRedeem?.status === "playing") {
      const label =
        rewardsCatalog.find((r) => r.id === data.lastRedeem.type)?.label ||
        data.lastRedeem.type;
      if (!els.form || els.form.classList.contains("hidden")) {
        // Soft status update while something plays
        if (!els.status.textContent.startsWith("Playing now")) {
          setStatus(`Playing now: ${label}`, "ok");
        }
      }
    }
  } catch (err) {
    setStatus(`Heartbeat failed: ${err.message}`, "err");
  }
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (document.visibilityState === "hidden") return;
    if (wheelCooldownMs > 0) {
      wheelCooldownMs = Math.max(0, wheelCooldownMs - tickMs);
      renderRewards(rewardsCatalog);
    }
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
