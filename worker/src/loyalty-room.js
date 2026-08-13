import { json, sanitizeDisplayName, sanitizeId } from "./auth.js";
import {
  DEFAULT_WHEEL_SEGMENTS,
  getReward,
  pickWeightedSegment,
  REWARDS,
} from "./rewards.js";

const DEFAULT_CONFIG = {
  pointsPerTick: 1,
  tickMs: 1000,
  minHeartbeatGapMs: 800,
  presenceTimeoutMs: 5000,
  maxPointsPerHour: 3600,
  redeemCooldownMs: 3000,
  alertMs: {
    shoutout: 7000,
    tts: 12000,
    highlight: 5000,
  },
  wheelCooldownMs: 60_000,
  autoPlayShoutouts: true,
  autoPlayWheel: true,
};

const CONFIG_BOUNDS = {
  pointsPerTick: [0, 10],
  tickMs: [200, 60_000],
  minHeartbeatGapMs: [200, 60_000],
  presenceTimeoutMs: [1_000, 120_000],
  maxPointsPerHour: [1, 10_000],
  redeemCooldownMs: [0, 60_000],
  wheelCooldownMs: [0, 600_000],
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
      this.clearExpiredAlert();
      return json(this.overlayState());
    }

    if (request.method === "GET" && url.pathname === "/rewards") {
      return json({
        rewards: REWARDS,
        config: this.state.config,
        wheelSegments: this.state.wheel.segments,
      });
    }

    if (request.method === "POST" && url.pathname === "/session") {
      const identity = await identityFromRequest(request);
      if (!identity.userId) return json({ error: "unauthorized" }, 401);
      const viewer = this.upsertViewer(identity);
      this.clearExpiredAlert();
      await this.persist();
      this.broadcast();
      return json({
        viewer: publicViewer(viewer),
        rewards: REWARDS,
        config: this.state.config,
        activePoll: publicPoll(this.state.activePoll),
        wheelCooldownMs: remainingCooldown(
          this.state.wheel.lastSpinAt,
          this.state.config.wheelCooldownMs,
        ),
      });
    }

    if (request.method === "POST" && url.pathname === "/heartbeat") {
      const identity = await identityFromRequest(request);
      if (!identity.userId) return json({ error: "unauthorized" }, 401);
      this.upsertViewer(identity);
      this.clearExpiredAlert();
      const result = this.heartbeat(identity.userId);
      if (!result.ok) return json(result, 400);
      if (!result.skipped) {
        await this.persist();
        this.broadcast();
      }
      return json({
        ...result,
        activePoll: publicPoll(this.state.activePoll),
        wheelCooldownMs: remainingCooldown(
          this.state.wheel.lastSpinAt,
          this.state.config.wheelCooldownMs,
        ),
        lastRedeem: lastRedeemForUser(this.state.redeemLog, identity.userId),
      });
    }

    if (request.method === "GET" && url.pathname === "/me") {
      const identity = identityFromHeaders(request);
      if (!identity.userId) return json({ error: "unauthorized" }, 401);
      const viewer = this.upsertViewer(identity);
      return json({
        viewer: publicViewer(viewer),
        lastRedeem: lastRedeemForUser(this.state.redeemLog, identity.userId),
        activePoll: publicPoll(this.state.activePoll),
      });
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

      if (reward.id === "wheel") {
        const left = remainingCooldown(
          this.state.wheel.lastSpinAt,
          this.state.config.wheelCooldownMs,
        );
        if (left > 0) {
          return json(
            { error: "cooldown", cooldownMs: left, viewer: publicViewer(this.state.viewers[identity.userId]) },
            429,
          );
        }
      }

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

      // Auto-play shoutouts / wheel when nothing else is playing.
      if (
        !this.nowPlaying() &&
        ((reward.id === "shoutout" && this.state.config.autoPlayShoutouts) ||
          (reward.id === "wheel" && this.state.config.autoPlayWheel))
      ) {
        this.playRedeem(result.event.id);
      }

      await this.persist();
      this.broadcast();
      return json({
        ...result,
        activePoll: publicPoll(this.state.activePoll),
        wheelCooldownMs: remainingCooldown(
          this.state.wheel.lastSpinAt,
          this.state.config.wheelCooldownMs,
        ),
      });
    }

    if (request.method === "POST" && url.pathname === "/vote") {
      const identity = identityFromHeaders(request);
      const body = await request.json().catch(() => ({}));
      this.upsertViewer(identity);
      const result = this.castVote(identity.userId, String(body.optionId || ""));
      if (!result.ok) {
        const status =
          result.error === "poll_closed" || result.error === "no_poll"
            ? 404
            : 400;
        return json(result, status);
      }
      await this.persist();
      this.broadcast();
      return json(result);
    }

    if (request.method === "GET" && url.pathname === "/admin/redeems") {
      return json({
        redeems: this.state.redeemLog,
        nowPlaying: this.nowPlaying(),
        activeAlert: this.state.activeAlert,
        activePoll: this.state.activePoll,
        wheel: this.state.wheel,
      });
    }

    if (request.method === "POST" && url.pathname.startsWith("/admin/redeems/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      // /admin/redeems/:id or /admin/redeems/:id/play|complete|reject|skip
      const id = parts[2];
      const action = parts[3] || "";
      const body = await request.json().catch(() => ({}));

      let status = typeof body.status === "string" ? body.status : "";
      if (action === "play") status = "playing";
      else if (action === "complete" || action === "done") status = "done";
      else if (action === "reject") status = "rejected";
      else if (action === "skip") status = "rejected";

      if (!["playing", "done", "rejected"].includes(status)) {
        return json({ error: "invalid_status" }, 400);
      }

      const result =
        status === "playing"
          ? this.playRedeem(id)
          : this.finishRedeem(id, status);

      if (!result.ok) {
        const code =
          result.error === "not_found"
            ? 404
            : result.error === "already_playing"
              ? 409
              : 400;
        return json(result, code);
      }
      await this.persist();
      this.broadcast();
      return json(result);
    }

    if (request.method === "POST" && url.pathname === "/admin/polls") {
      const body = await request.json().catch(() => ({}));
      const result = this.startPoll(body);
      if (!result.ok) return json(result, 400);
      await this.persist();
      this.broadcast();
      return json(result);
    }

    if (
      request.method === "POST" &&
      url.pathname.startsWith("/admin/polls/") &&
      url.pathname.endsWith("/close")
    ) {
      const id = url.pathname.split("/")[3];
      const result = this.closePoll(id);
      if (!result.ok) return json(result, result.error === "not_found" ? 404 : 400);
      await this.persist();
      this.broadcast();
      return json(result);
    }

    if (request.method === "POST" && url.pathname === "/admin/reset") {
      this.state = freshState();
      await this.ctx.storage.deleteAlarm();
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
      for (const key of ["autoPlayShoutouts", "autoPlayWheel"]) {
        if (typeof body[key] === "boolean") this.state.config[key] = body[key];
      }
      if (body.alertMs && typeof body.alertMs === "object") {
        this.state.config.alertMs = {
          ...this.state.config.alertMs,
          ...body.alertMs,
        };
      }
      if (Array.isArray(body.wheelSegments) && body.wheelSegments.length >= 2) {
        this.state.wheel.segments = body.wheelSegments.map((s, i) => ({
          id: String(s.id || `seg${i}`),
          label: String(s.label || `Option ${i + 1}`),
          weight: Number(s.weight) || 1,
          color: typeof s.color === "string" ? s.color : undefined,
        }));
      }
      await this.persist();
      this.broadcast();
      return json({ config: this.state.config, wheel: this.state.wheel });
    }

    return json({ error: "not_found" }, 404);
  }

  async alarm() {
    await this.ensureState();
    const alert = this.state.activeAlert;
    if (alert?.endsAt && Date.now() >= alert.endsAt) {
      if (alert.redeemId) {
        const event = this.state.redeemLog.find((e) => e.id === alert.redeemId);
        if (event && event.status === "playing") {
          this.finishRedeem(event.id, "done");
        } else {
          this.state.activeAlert = null;
          if (this.state.wheel.pendingResult?.redeemId === alert.redeemId) {
            this.state.wheel.pendingResult = null;
          }
        }
      } else {
        this.state.activeAlert = null;
      }
      await this.persist();
      this.broadcast();
    }

    const poll = this.state.activePoll;
    if (poll?.status === "open" && poll.endsAt && Date.now() >= poll.endsAt) {
      this.closePoll(poll.id);
      await this.persist();
      this.broadcast();
    }

    await this.scheduleNextAlarm();
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
        this.clearExpiredAlert();
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
    this.clearExpiredAlert();
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
    await this.scheduleNextAlarm();
  }

  async scheduleNextAlarm() {
    const times = [];
    if (this.state.activeAlert?.endsAt) times.push(this.state.activeAlert.endsAt);
    if (
      this.state.activePoll?.status === "open" &&
      this.state.activePoll.endsAt
    ) {
      times.push(this.state.activePoll.endsAt);
    }
    if (!times.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...times);
    await this.ctx.storage.setAlarm(next);
  }

  broadcast() {
    this.refreshPresence();
    this.clearExpiredAlert();
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
        cooldownMs: remainingCooldown(
          viewer.lastRedeemAt,
          this.state.config.redeemCooldownMs,
        ),
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
      playedAt: null,
      completedAt: null,
      refunded: false,
      result: null,
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

  nowPlaying() {
    return this.state.redeemLog.find((e) => e.status === "playing") || null;
  }

  /**
   * @param {string} id
   */
  playRedeem(id) {
    const event = this.state.redeemLog.find((e) => e.id === id);
    if (!event) return { ok: false, error: "not_found" };
    if (event.status === "playing") return { ok: true, event };
    if (event.status !== "queued") {
      return { ok: false, error: "not_queued", event };
    }

    const current = this.nowPlaying();
    if (current && current.id !== id) {
      return { ok: false, error: "already_playing", event: current };
    }

    event.status = "playing";
    event.playedAt = Date.now();

    if (event.type === "wheel") {
      const picked = pickWeightedSegment(this.state.wheel.segments);
      const segment = picked?.segment;
      const index = picked?.index ?? 0;
      event.result = {
        segmentId: segment?.id,
        label: segment?.label,
        index,
        color: segment?.color,
      };
      this.state.wheel.lastSpinAt = Date.now();
      this.state.wheel.pendingResult = {
        redeemId: event.id,
        segmentId: segment?.id,
        label: segment?.label,
        index,
        color: segment?.color,
        displayName: event.displayName,
        spunAt: Date.now(),
      };
      const spinMs = 6500;
      const holdMs = 8000;
      this.state.activeAlert = {
        redeemId: event.id,
        kind: "wheel",
        displayName: event.displayName,
        text: segment?.label || "Challenge",
        title: null,
        segmentIndex: index,
        segments: this.state.wheel.segments,
        startedAt: Date.now(),
        endsAt: Date.now() + spinMs + holdMs,
        spinMs,
      };
    } else if (event.type === "song") {
      this.state.activeAlert = {
        redeemId: event.id,
        kind: "song",
        displayName: event.displayName,
        text: event.payload?.text || "",
        title: event.payload?.text || "Song request",
        startedAt: Date.now(),
        endsAt: null,
      };
    } else if (event.type === "tts") {
      const ms = this.state.config.alertMs.tts || 12000;
      this.state.activeAlert = {
        redeemId: event.id,
        kind: "tts",
        displayName: event.displayName,
        text: event.payload?.text || "",
        title: null,
        startedAt: Date.now(),
        endsAt: Date.now() + ms,
      };
    } else {
      // shoutout and anything else
      const ms = this.state.config.alertMs.shoutout || 7000;
      this.state.activeAlert = {
        redeemId: event.id,
        kind: event.type === "shoutout" ? "shoutout" : event.type,
        displayName: event.displayName,
        text: event.payload?.text || "",
        title: null,
        startedAt: Date.now(),
        endsAt: Date.now() + ms,
      };
    }

    return { ok: true, event, activeAlert: this.state.activeAlert };
  }

  /**
   * @param {string} id
   * @param {"done" | "rejected"} status
   */
  finishRedeem(id, status) {
    const event = this.state.redeemLog.find((e) => e.id === id);
    if (!event) return { ok: false, error: "not_found" };
    if (event.status === "done" || event.status === "rejected") {
      return { ok: true, event };
    }

    event.status = status;
    event.completedAt = Date.now();

    if (status === "rejected" && !event.refunded) {
      const viewer = this.state.viewers[event.userId];
      if (viewer) {
        viewer.points += event.cost;
        viewer.spentTotal = Math.max(0, viewer.spentTotal - event.cost);
      }
      event.refunded = true;
    }

    if (this.state.activeAlert?.redeemId === id) {
      this.state.activeAlert = null;
    }
    if (this.state.wheel.pendingResult?.redeemId === id) {
      this.state.wheel.pendingResult = null;
    }

    return { ok: true, event };
  }

  /**
   * @param {Record<string, unknown>} body
   */
  startPoll(body) {
    if (this.state.activePoll?.status === "open") {
      return { ok: false, error: "poll_open" };
    }

    const question = String(body.question || "").trim();
    if (!question) return { ok: false, error: "question_required" };

    let options = Array.isArray(body.options) ? body.options : [];
    options = options
      .map((o, i) => ({
        id: String(o?.id || `opt${i + 1}`),
        label: String(o?.label || o || "").trim(),
        votes: 0,
      }))
      .filter((o) => o.label);

    if (options.length < 2 || options.length > 4) {
      return { ok: false, error: "options_2_to_4" };
    }

    const durationMs = Math.min(
      Math.max(Number(body.durationMs) || 60_000, 10_000),
      600_000,
    );

    const poll = {
      id: `p${++this.state.pollSeq}`,
      question,
      options,
      endsAt: Date.now() + durationMs,
      status: "open",
      voters: {},
      createdAt: Date.now(),
      closedAt: null,
    };
    this.state.activePoll = poll;
    this.pushOverlay({
      kind: "poll",
      displayName: "Poll",
      message: `Poll: ${question}`,
    });
    return { ok: true, poll: publicPoll(poll) };
  }

  /**
   * @param {string} id
   */
  closePoll(id) {
    const poll = this.state.activePoll;
    if (!poll || poll.id !== id) return { ok: false, error: "not_found" };
    if (poll.status === "closed") return { ok: true, poll: publicPoll(poll) };
    poll.status = "closed";
    poll.closedAt = Date.now();
    // Keep closed poll visible briefly via endsAt for overlay; clear after 10s display
    poll.endsAt = Date.now() + 10_000;
    return { ok: true, poll: publicPoll(poll) };
  }

  /**
   * @param {string} userId
   * @param {string} optionId
   */
  castVote(userId, optionId) {
    const poll = this.state.activePoll;
    if (!poll || poll.status !== "open") {
      return { ok: false, error: "no_poll" };
    }
    if (poll.endsAt && Date.now() >= poll.endsAt) {
      this.closePoll(poll.id);
      return { ok: false, error: "poll_closed" };
    }
    if (poll.voters[userId]) {
      return {
        ok: false,
        error: "already_voted",
        poll: publicPoll(poll),
        viewer: publicViewer(this.state.viewers[userId]),
      };
    }
    const option = poll.options.find((o) => o.id === optionId);
    if (!option) return { ok: false, error: "bad_option" };

    poll.voters[userId] = { optionId, paidVotes: 0 };
    option.votes += 1;

    return {
      ok: true,
      poll: publicPoll(poll),
      viewer: publicViewer(this.state.viewers[userId]),
    };
  }

  clearExpiredAlert() {
    const alert = this.state.activeAlert;
    if (alert?.endsAt && Date.now() >= alert.endsAt) {
      if (alert.redeemId) {
        const event = this.state.redeemLog.find((e) => e.id === alert.redeemId);
        if (event && event.status === "playing" && event.type !== "song") {
          this.finishRedeem(event.id, "done");
          return;
        }
      }
      this.state.activeAlert = null;
    }

    const poll = this.state.activePoll;
    if (
      poll?.status === "open" &&
      poll.endsAt &&
      Date.now() >= poll.endsAt
    ) {
      this.closePoll(poll.id);
    } else if (
      poll?.status === "closed" &&
      poll.endsAt &&
      Date.now() >= poll.endsAt
    ) {
      this.state.activePoll = null;
    }
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
      nowPlaying: publicRedeem(this.nowPlaying()),
      activeAlert: this.state.activeAlert,
      activePoll: publicPoll(this.state.activePoll),
      wheel: {
        segments: this.state.wheel.segments,
        pendingResult: this.state.wheel.pendingResult,
        cooldownMs: remainingCooldown(
          this.state.wheel.lastSpinAt,
          this.state.config.wheelCooldownMs,
        ),
      },
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
    config: {
      ...DEFAULT_CONFIG,
      alertMs: { ...DEFAULT_CONFIG.alertMs },
    },
    viewers: {},
    redeemLog: [],
    overlayEvents: [],
    redeemSeq: 0,
    overlaySeq: 0,
    pollSeq: 0,
    lastChannelId: null,
    lastChannelAt: null,
    activeAlert: null,
    activePoll: null,
    wheel: {
      segments: DEFAULT_WHEEL_SEGMENTS.map((s) => ({ ...s })),
      lastSpinAt: 0,
      pendingResult: null,
    },
  };
}

function serializeState(state) {
  return state;
}

function reviveState(saved) {
  const base = freshState();
  const config = { ...base.config, ...(saved.config || {}) };
  for (const key of Object.keys(CONFIG_BOUNDS)) {
    const next = clampConfigNumber(key, config[key]);
    config[key] = next === null ? DEFAULT_CONFIG[key] : next;
  }
  config.alertMs = {
    ...base.config.alertMs,
    ...(saved.config?.alertMs || {}),
  };
  return {
    ...base,
    ...saved,
    config,
    viewers: saved.viewers || {},
    redeemLog: saved.redeemLog || [],
    overlayEvents: saved.overlayEvents || [],
    activeAlert: saved.activeAlert || null,
    activePoll: saved.activePoll || null,
    wheel: {
      ...base.wheel,
      ...(saved.wheel || {}),
      segments:
        saved.wheel?.segments?.length >= 2
          ? saved.wheel.segments
          : base.wheel.segments,
    },
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
  if (!viewer) return null;
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

function publicPoll(poll) {
  if (!poll) return null;
  return {
    id: poll.id,
    question: poll.question,
    options: poll.options.map((o) => ({
      id: o.id,
      label: o.label,
      votes: o.votes,
    })),
    endsAt: poll.endsAt,
    status: poll.status,
    createdAt: poll.createdAt,
    closedAt: poll.closedAt,
    totalVotes: poll.options.reduce((sum, o) => sum + o.votes, 0),
    myVote: undefined,
  };
}

function remainingCooldown(lastAt, cooldownMs) {
  if (!lastAt || !cooldownMs) return 0;
  return Math.max(0, lastAt + cooldownMs - Date.now());
}

function lastRedeemForUser(log, userId) {
  return log.find((e) => e.userId === userId) || null;
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
  if (!event) return null;
  return {
    id: event.id,
    displayName: event.displayName,
    type: event.type,
    payload: event.payload,
    cost: event.cost,
    createdAt: event.createdAt,
    status: event.status,
    result: event.result || null,
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
