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

/**
 * Shared Extension client for the panel and video-overlay HUD.
 *
 * @param {{
 *   earnSurface?: "panel" | "overlay",
 *   allowHeartbeat?: () => boolean,
 *   isRedeemFormOpen?: () => boolean,
 *   onChange?: () => void,
 *   onStatus?: (text: string, kind?: string) => void,
 * }} hooks
 */
export function createLoyaltyClient(hooks = {}) {
  const earnSurface = hooks.earnSurface === "overlay" ? "overlay" : "panel";

  /** @type {string | null} */
  let authToken = null;
  /** @type {string | null} */
  let helixToken = null;
  /** @type {string | null} */
  let twitchClientId = null;
  /** @type {string | null} */
  let twitchDisplayName = null;
  /** @type {"twitch" | "dev"} */
  let authMode = "dev";
  let sessionStarted = false;
  let extVisible = true;
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

  function notify() {
    hooks.onChange?.();
  }

  /** @type {string} */
  let lastStatus = "";

  function setStatus(text, kind = "") {
    lastStatus = text;
    hooks.onStatus?.(text, kind);
  }

  function getState() {
    return {
      authMode,
      sessionStarted,
      viewer: currentViewer,
      rewards: rewardsCatalog,
      poll: activePoll,
      myVoteOptionId,
      wheelCooldownMs,
      pendingReward,
      tickMs,
      pointsPerTick,
      earnRateLabel: formatEarnRate(earnSurface, tickMs, pointsPerTick),
      showShareIdentity: authMode === "twitch" && !twitchViewerLinked(),
    };
  }

  function authHeaders() {
    /** @type {Record<string, string>} */
    const headers = { "Content-Type": "application/json" };
    if (authMode === "twitch" && authToken) {
      headers.Authorization = `Bearer ${authToken}`;
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

  function applyViewer(viewer) {
    if (!viewer) return;
    currentViewer = viewer;
  }

  function openRedeem(reward) {
    pendingReward = reward;
    notify();
    if (!reward.needsText) {
      void submitRedeem("");
    }
  }

  function closeRedeem() {
    pendingReward = null;
    notify();
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
    try {
      const result = await api("/viewer/redeem", {
        method: "POST",
        body: JSON.stringify({ type: pendingReward.id, text }),
      });
      applyViewer(result.viewer);
      if (typeof result.wheelCooldownMs === "number") {
        wheelCooldownMs = result.wheelCooldownMs;
      }
      if (result.activePoll) activePoll = result.activePoll;
      setStatus(statusForRedeem(result.event, pendingReward.label), "ok");
      closeRedeem();
    } catch (err) {
      const code = err?.data?.error;
      const msg =
        code === "insufficient_points"
          ? "Not enough points"
          : code === "cooldown"
            ? err.data.cooldownMs
              ? `Cooldown ${formatMs(err.data.cooldownMs)}`
              : "Too fast — wait a second"
            : err.message;
      setStatus(msg, "err");
      notify();
    }
  }

  async function castVote(optionId) {
    try {
      const result = await api("/viewer/vote", {
        method: "POST",
        body: JSON.stringify({ optionId }),
      });
      myVoteOptionId = optionId;
      if (result.viewer) applyViewer(result.viewer);
      if (result.poll) activePoll = result.poll;
      setStatus("Vote counted", "ok");
      notify();
    } catch (err) {
      if (err?.data?.error === "already_voted") {
        myVoteOptionId = optionId;
        if (err.data.poll) activePoll = err.data.poll;
        setStatus("Already voted", "ok");
        notify();
        return;
      }
      setStatus(err.message, "err");
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

  async function resolveTwitchName() {
    const viewer = window.Twitch?.ext?.viewer;
    if (!viewer?.isLinked || !viewer.id || !helixToken || !twitchClientId) {
      notify();
      return;
    }
    notify();
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
    rewardsCatalog = data.rewards || [];
    applyViewer(data.viewer);
    if (typeof data.wheelCooldownMs === "number") {
      wheelCooldownMs = data.wheelCooldownMs;
    }
    myVoteOptionId = null;
    activePoll = data.activePoll || null;
    setStatus(
      authMode === "twitch"
        ? "Watching · earning points"
        : "Dev mode · earning points",
      "ok",
    );
    startHeartbeat();
    notify();
  }

  async function beat() {
    try {
      const data = await api("/viewer/heartbeat", {
        method: "POST",
        body: sessionBody(),
      });
      applyViewer(data.viewer);
      if (typeof data.wheelCooldownMs === "number") {
        wheelCooldownMs = data.wheelCooldownMs;
      }
      if (data.activePoll) {
        activePoll = data.activePoll;
      } else {
        myVoteOptionId = null;
        activePoll = null;
      }
      if (data.lastRedeem?.status === "playing") {
        const label =
          rewardsCatalog.find((r) => r.id === data.lastRedeem.type)?.label ||
          data.lastRedeem.type;
        if (!hooks.isRedeemFormOpen?.() && !lastStatus.startsWith("Playing now")) {
          setStatus(`Playing now: ${label}`, "ok");
        }
      }
      notify();
    } catch (err) {
      setStatus(`Heartbeat failed: ${err.message}`, "err");
    }
  }

  function canHeartbeat() {
    if (document.visibilityState === "hidden") return false;
    if (!extVisible) return false;
    if (hooks.allowHeartbeat && !hooks.allowHeartbeat()) return false;
    return true;
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = setInterval(() => {
      if (wheelCooldownMs > 0) {
        wheelCooldownMs = Math.max(0, wheelCooldownMs - tickMs);
        notify();
      }
      if (!canHeartbeat()) return;
      void beat();
    }, tickMs);
    if (canHeartbeat()) void beat();
  }

  function begin(mode) {
    if (sessionStarted) return;
    sessionStarted = true;
    authMode = mode;
    void startSession().catch((err) =>
      setStatus(startErrorMessage(err), "err"),
    );
  }

  function setExtVisible(isVisible) {
    extVisible = Boolean(isVisible);
    if (extVisible && sessionStarted && canHeartbeat()) void beat();
  }

  function boot() {
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

    window.Twitch.ext.onVisibilityChanged?.((isVisible) => {
      setExtVisible(isVisible);
    });

    // Standalone /panel or /video-overlay pages need a DevViewer fallback.
    // The Twitch Extension always runs in an iframe and waits for onAuthorized.
    if (window === window.top) {
      setTimeout(() => {
        if (!sessionStarted) begin("dev");
      }, 2000);
    }
  }

  return {
    boot,
    getState,
    openRedeem,
    closeRedeem,
    submitRedeem,
    castVote,
    requestIdentityShare,
    setExtVisible,
  };
}

function startErrorMessage(err) {
  const code = err?.data?.error || err.message;
  if (code === "ext_secret_missing" || code === "invalid_token") {
    return "JWT failed. Set EXT_SECRET from the Twitch Extension Client Secret.";
  }
  if (code === "unauthorized") {
    return "Open this from the Twitch Extension, not the Worker URL.";
  }
  return `Failed to start: ${err.message}`;
}

export function formatEarnRate(earnSurface, tickMs, pointsPerTick) {
  const surface = earnSurface === "overlay" ? "overlay" : "panel";
  const perSec = pointsPerTick / Math.max(tickMs / 1000, 0.001);
  return perSec >= 0.95
    ? `+${pointsPerTick} / sec while this ${surface} is open`
    : `+${pointsPerTick} every ${Math.round(tickMs / 1000)}s while this ${surface} is open`;
}

export function formatMs(ms) {
  const sec = Math.ceil(ms / 1000);
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}:${String(s).padStart(2, "0")}` : `${s}s`;
}

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
