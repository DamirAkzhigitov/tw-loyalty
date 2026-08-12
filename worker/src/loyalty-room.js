import { json, sanitizeDisplayName, sanitizeId } from "./auth.js";
import { getReward, REWARDS } from "./rewards.js";

const DEFAULT_CONFIG = {
  pointsPerTick: 1,
  tickMs: 1000,
  minHeartbeatGapMs: 800,
  presenceTimeoutMs: 5000,
  maxPointsPerHour: 3600,
  redeemCooldownMs: 3000,
};

const CONFIG_BOUNDS = {
  pointsPerTick: [0, 10],
  tickMs: [200, 60_000],
  minHeartbeatGapMs: [200, 60_000],
  presenceTimeoutMs: [1_000, 120_000],
  maxPointsPerHour: [1, 10_000],
  redeemCooldownMs: [0, 60_000],
};

const MAX_OVERLAY_EVENTS = 30;
const MAX_REDEEM_LOG = 100;
const MAX_SOCKETS = 32;
const HOUR_MS = 3_600_000;

/**
 * One Durable Object = one channel's loyalty room.
 * Holds shared points state + overlay WebSocket clients.
 */
export class LoyaltyRoom {
  /**
   * @param {DurableObjectState} ctx
   * @param {Env} env
   */
  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    /** @type {null | RoomState} */
    this.state = null;
  }

  /**
   * @param {Request} request
   */
  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.acceptWebSocket();
    }

    await this.ensureState();

    if (request.method === "POST" && url.pathname === "/touch") {
      const body = await request.json().catch(() => ({}));
      const channelId = String(body.channelId || "").trim();
      if (!channelId) return json({ error: "channel_required" }, 400);
      this.state.lastChannelId = channelId;
      this.state.lastChannelAt = Date.now();
      await this.persist();
      return json({ ok: true, channelId });
    }

    if (request.method === "GET" && url.pathname === "/last") {
      return json({
        channelId: this.state.lastChannelId || null,
        updatedAt: this.state.lastChannelAt || null,
      });
    }

    if (request.method === "GET" && url.pathname === "/overlay") {
      this.refreshPresence();
      return json(this.overlayState());
    }

    if (request.method === "GET" && url.pathname === "/rewards") {
      return json({ rewards: REWARDS, config: this.state.config });
    }

    if (request.method === "POST" && url.pathname === "/session") {
      const identity = await identityFromRequest(request);
      if (!identity.userId) return json({ error: "unauthorized" }, 401);
      const viewer = this.upsertViewer(identity);
      await this.persist();
      this.broadcast();
      return json({
        viewer: publicViewer(viewer),
        rewards: REWARDS,
        config: this.state.config,
      });
    }

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const identity = await identityFromRequest(request);
      if (!identity.userId) return json({ error: "unauthorized" }, 401);
      this.upsertViewer(identity);
      const result = this.heartbeat(identity.userId);
      if (!result.ok) return json(result, 400);
      if (!result.skipped) {
        await this.persist();
        this.broadcast();
      }
      return json(result);
    }

    if (request.method === "GET" && url.pathname === "/me") {
      const identity = identityFromHeaders(request);
      if (!identity.userId) return json({ error: "unauthorized" }, 401);
      const viewer = this.upsertViewer(identity);
      return json({ viewer: publicViewer(viewer) });
    }

    if (request.method === "POST" && url.pathname === "/redeem") {
      const identity = identityFromHeaders(request);
      if (!identity.userId) return json({ error: "unauthorized" }, 401);
      const body = await request.json().catch(() => ({}));
      const reward = getReward(String(body.type ?? ""));
      if (!reward) return json({ error: "unknown_reward" }, 400);

      let text = typeof body.text === "string" ? body.text.trim() : "";
      text = text.replace(/[\u0000-\u001F\u007F]/g, "");
      if (reward.needsText && !text) {
        return json({ error: "text_required" }, 400);
      }
      if (text && reward.maxLength) text = text.slice(0, reward.maxLength);

      this.upsertViewer(identity);
      const result = this.redeem({
        userId: identity.userId,
        type: reward.id,
        cost: reward.cost,
        payload: { text },
      });
      if (!result.ok) {
        const status =
          result.error === "insufficient_points"
            ? 402
            : result.error === "cooldown"
              ? 429
              : 400;
        return json(result, status);
      }
      await this.persist();
      this.broadcast();
      return json(result);
    }

    if (request.method === "GET" && url.pathname === "/admin/redeems") {
      return json({ redeems: this.state.redeemLog });
    }

    if (request.method === "POST" && url.pathname.startsWith("/admin/redeems/")) {
      const id = url.pathname.split("/").pop();
      const body = await request.json().catch(() => ({}));
      if (body.status !== "done" && body.status !== "rejected") {
        return json({ error: "invalid_status" }, 400);
      }
      const event = this.state.redeemLog.find((e) => e.id === id);
      if (!event) return json({ error: "not_found" }, 404);
      event.status = body.status;
      await this.persist();
      this.broadcast();
      return json({ ok: true, event });
    }

    if (request.method === "POST" && url.pathname === "/admin/reset") {
      this.state = freshState();
      await this.persist();
      this.broadcast();
      return json({ ok: true });
    }

    if (request.method === "PATCH" && url.pathname === "/admin/config") {
      const body = await request.json().catch(() => ({}));
      for (const key of Object.keys(CONFIG_BOUNDS)) {
        const next = clampConfigNumber(key, body[key]);
        if (next !== null) this.state.config[key] = next;
      }
      await this.persist();
      this.broadcast();
      return json({ config: this.state.config });
    }

    return json({ error: "not_found" }, 404);
  }

  acceptWebSocket() {
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS) {
      return json({ error: "too_many_connections" }, 503);
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);

    this.ctx.waitUntil(
      this.ensureState().then(() => {
        this.refreshPresence();
        try {
          server.send(
            JSON.stringify({ type: "overlay", data: this.overlayState() }),
          );
        } catch {
          // socket may already be closed
        }
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  /**
   * @param {WebSocket} _ws
   * @param {string | ArrayBuffer} _message
   */
  async webSocketMessage(_ws, _message) {
    await this.ensureState();
    this.refreshPresence();
    _ws.send(JSON.stringify({ type: "overlay", data: this.overlayState() }));
  }

  webSocketClose() {}

  webSocketError() {}

  async ensureState() {
    if (this.state) return;
    const saved = await this.ctx.storage.get("state");
    this.state = saved ? reviveState(saved) : freshState();
  }

  async persist() {
    await this.ctx.storage.put("state", serializeState(this.state));
  }

  broadcast() {
    this.refreshPresence();
    const payload = JSON.stringify({
      type: "overlay",
      data: this.overlayState(),
    });
    for (const ws of this.ctx.getWebSockets()) {
      try {
        ws.send(payload);
      } catch {
        // ignore broken sockets
      }
    }
  }

  /**
   * @param {{ userId: string, opaqueUserId?: string, displayName?: string }} identity
   */
  upsertViewer(identity) {
    let viewer = this.state.viewers[identity.userId];
    const displayName = sanitizeDisplayName(identity.displayName);
    if (!viewer) {
      viewer = {
        userId: identity.userId,
        opaqueUserId: identity.opaqueUserId ?? identity.userId,
        displayName: displayName || `User-${identity.userId.slice(-4)}`,
        points: 0,
        lastHeartbeatAt: 0,
        lastRedeemAt: 0,
        watching: false,
        earnedTotal: 0,
        spentTotal: 0,
        earnedWindowStart: 0,
        earnedInWindow: 0,
      };
      this.state.viewers[identity.userId] = viewer;
    } else {
      if (displayName) viewer.displayName = displayName;
      if (identity.opaqueUserId) viewer.opaqueUserId = identity.opaqueUserId;
    }
    return viewer;
  }

  /**
   * @param {string} userId
   * @param {number} [now]
   */
  heartbeat(userId, now = Date.now()) {
    const viewer = this.state.viewers[userId];
    if (!viewer) return { ok: false, error: "unknown_viewer" };

    const gap = now - viewer.lastHeartbeatAt;
    if (viewer.lastHeartbeatAt > 0 && gap < this.state.config.minHeartbeatGapMs) {
      return {
        ok: true,
        skipped: true,
        reason: "too_fast",
        viewer: publicViewer(viewer),
      };
    }

    if (!viewer.earnedWindowStart || now - viewer.earnedWindowStart >= HOUR_MS) {
      viewer.earnedWindowStart = now;
      viewer.earnedInWindow = 0;
    }
    const award = this.state.config.pointsPerTick;
    if (viewer.earnedInWindow + award > this.state.config.maxPointsPerHour) {
      viewer.lastHeartbeatAt = now;
      viewer.watching = true;
      return {
        ok: true,
        skipped: true,
        reason: "hourly_cap",
        viewer: publicViewer(viewer),
      };
    }

    const wasWatching = viewer.watching;
    viewer.lastHeartbeatAt = now;
    viewer.watching = true;
    viewer.points += award;
    viewer.earnedTotal += award;
    viewer.earnedInWindow += award;

    if (!wasWatching) {
      this.pushOverlay({
        kind: "presence",
        displayName: viewer.displayName,
        message: `${viewer.displayName} is watching`,
      });
    }

    return {
      ok: true,
      skipped: false,
      awarded: award,
      viewer: publicViewer(viewer),
    };
  }

  /**
   * @param {{ userId: string, type: string, payload?: Record<string, unknown>, cost: number }} input
   */
  redeem(input) {
    const viewer = this.state.viewers[input.userId];
    if (!viewer) return { ok: false, error: "unknown_viewer" };
    if (input.cost < 0) return { ok: false, error: "invalid_cost" };
    const now = Date.now();
    if (
      this.state.config.redeemCooldownMs > 0 &&
      viewer.lastRedeemAt &&
      now - viewer.lastRedeemAt < this.state.config.redeemCooldownMs
    ) {
      return {
        ok: false,
        error: "cooldown",
        viewer: publicViewer(viewer),
      };
    }
    if (viewer.points < input.cost) {
      return {
        ok: false,
        error: "insufficient_points",
        viewer: publicViewer(viewer),
      };
    }

    viewer.points -= input.cost;
    viewer.spentTotal += input.cost;
    viewer.lastRedeemAt = now;

    const event = {
      id: `r${++this.state.redeemSeq}`,
      userId: viewer.userId,
      displayName: viewer.displayName,
      type: input.type,
      payload: input.payload ?? {},
      cost: input.cost,
      createdAt: now,
      status: "queued",
    };

    this.state.redeemLog.unshift(event);
    if (this.state.redeemLog.length > MAX_REDEEM_LOG) {
      this.state.redeemLog.length = MAX_REDEEM_LOG;
    }

    this.pushOverlay({
      kind: "redeem",
      displayName: viewer.displayName,
      message: `${viewer.displayName} spent ${input.cost} pts · ${input.type}`,
    });

    return { ok: true, event, viewer: publicViewer(viewer) };
  }

  refreshPresence(now = Date.now()) {
    for (const viewer of Object.values(this.state.viewers)) {
      if (
        viewer.watching &&
        now - viewer.lastHeartbeatAt > this.state.config.presenceTimeoutMs
      ) {
        viewer.watching = false;
      }
    }
  }

  overlayState() {
    const watching = Object.values(this.state.viewers)
      .filter((v) => v.watching)
      .map(overlayViewer)
      .sort((a, b) => b.points - a.points);

    const leaderboard = Object.values(this.state.viewers)
      .map(overlayViewer)
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);

    return {
      config: this.state.config,
      watching,
      leaderboard,
      recent: this.state.overlayEvents.slice(0, 10),
      queue: this.state.redeemLog
        .filter((e) => e.status === "queued")
        .slice(0, 20)
        .map(publicRedeem),
    };
  }

  /**
   * @param {{ kind: string, displayName: string, message: string }} partial
   */
  pushOverlay(partial) {
    this.state.overlayEvents.unshift({
      id: `o${++this.state.overlaySeq}`,
      createdAt: Date.now(),
      ...partial,
    });
    if (this.state.overlayEvents.length > MAX_OVERLAY_EVENTS) {
      this.state.overlayEvents.length = MAX_OVERLAY_EVENTS;
    }
  }
}

function freshState() {
  return {
    config: { ...DEFAULT_CONFIG },
    viewers: {},
    redeemLog: [],
    overlayEvents: [],
    redeemSeq: 0,
    overlaySeq: 0,
    lastChannelId: null,
    lastChannelAt: null,
  };
}

function serializeState(state) {
  return state;
}

function reviveState(saved) {
  const config = { ...DEFAULT_CONFIG, ...(saved.config || {}) };
  for (const key of Object.keys(CONFIG_BOUNDS)) {
    const next = clampConfigNumber(key, config[key]);
    config[key] = next === null ? DEFAULT_CONFIG[key] : next;
  }
  return {
    ...freshState(),
    ...saved,
    config,
    viewers: saved.viewers || {},
    redeemLog: saved.redeemLog || [],
    overlayEvents: saved.overlayEvents || [],
  };
}

function clampConfigNumber(key, value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const bounds = CONFIG_BOUNDS[key];
  if (!bounds) return null;
  const [min, max] = bounds;
  return Math.min(max, Math.max(min, value));
}

function publicViewer(viewer) {
  return {
    userId: viewer.userId,
    displayName: viewer.displayName,
    points: viewer.points,
    watching: viewer.watching,
    earnedTotal: viewer.earnedTotal,
    spentTotal: viewer.spentTotal,
    lastHeartbeatAt: viewer.lastHeartbeatAt,
  };
}

function overlayViewer(viewer) {
  return {
    displayName: viewer.displayName,
    points: viewer.points,
    watching: viewer.watching,
    earnedTotal: viewer.earnedTotal,
    spentTotal: viewer.spentTotal,
  };
}

function publicRedeem(event) {
  return {
    id: event.id,
    displayName: event.displayName,
    type: event.type,
    payload: event.payload,
    cost: event.cost,
    createdAt: event.createdAt,
    status: event.status,
  };
}

/**
 * @param {Request} request
 */
function identityFromHeaders(request) {
  return {
    userId: sanitizeId(request.headers.get("X-Viewer-Id")),
    opaqueUserId: sanitizeId(request.headers.get("X-Viewer-Opaque-Id")) || undefined,
    displayName: sanitizeDisplayName(request.headers.get("X-Viewer-Name")) || undefined,
  };
}

/**
 * Headers plus optional JSON body fields (displayName).
 * @param {Request} request
 */
async function identityFromRequest(request) {
  const identity = identityFromHeaders(request);
  const clone = request.clone();
  const body = await clone.json().catch(() => ({}));
  const fromBody = sanitizeDisplayName(body.displayName);
  if (fromBody) identity.displayName = fromBody;
  return identity;
}
