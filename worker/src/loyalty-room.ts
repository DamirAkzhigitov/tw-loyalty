import { json, sanitizeDisplayName, sanitizeId } from "./auth";
import {
  DEFAULT_WHEEL_SEGMENTS,
  getReward,
  pickWeightedSegment,
  REWARDS,
  type WheelSegment,
} from "./rewards";

type RedeemStatus = "queued" | "playing" | "done" | "rejected";

type RoomConfig = {
  pointsPerTick: number;
  tickMs: number;
  minHeartbeatGapMs: number;
  presenceTimeoutMs: number;
  maxPointsPerHour: number;
  redeemCooldownMs: number;
  alertMs: {
    shoutout: number;
    tts: number;
    highlight: number;
  };
  wheelCooldownMs: number;
  autoPlayShoutouts: boolean;
  autoPlayWheel: boolean;
};

type Viewer = {
  userId: string;
  opaqueUserId: string;
  displayName: string;
  points: number;
  lastHeartbeatAt: number;
  lastRedeemAt: number;
  watching: boolean;
  earnedTotal: number;
  spentTotal: number;
  earnedWindowStart: number;
  earnedInWindow: number;
};

type RedeemEvent = {
  id: string;
  userId: string;
  displayName: string;
  type: string;
  payload: Record<string, unknown>;
  cost: number;
  createdAt: number;
  status: RedeemStatus;
  playedAt: number | null;
  completedAt: number | null;
  refunded: boolean;
  result: Record<string, unknown> | null;
};

type OverlayEvent = {
  id: string;
  createdAt: number;
  kind: string;
  displayName: string;
  message: string;
};

type ActiveAlert = {
  redeemId: string;
  kind: string;
  displayName: string;
  text: string;
  title: string | null;
  startedAt: number;
  endsAt: number | null;
  segmentIndex?: number;
  segments?: WheelSegment[];
  spinMs?: number;
};

type PollOption = {
  id: string;
  label: string;
  votes: number;
};

type Poll = {
  id: string;
  question: string;
  options: PollOption[];
  endsAt: number;
  status: "open" | "closed";
  voters: Record<string, { optionId: string; paidVotes: number }>;
  createdAt: number;
  closedAt: number | null;
};

type WheelState = {
  segments: WheelSegment[];
  lastSpinAt: number;
  pendingResult: {
    redeemId: string;
    segmentId?: string;
    label?: string;
    index: number;
    color?: string;
    displayName: string;
    spunAt: number;
  } | null;
};

type RoomState = {
  config: RoomConfig;
  viewers: Record<string, Viewer>;
  redeemLog: RedeemEvent[];
  overlayEvents: OverlayEvent[];
  redeemSeq: number;
  overlaySeq: number;
  pollSeq: number;
  lastChannelId: string | null;
  lastChannelAt: number | null;
  activeAlert: ActiveAlert | null;
  activePoll: Poll | null;
  wheel: WheelState;
};

type ViewerIdentity = {
  userId: string;
  opaqueUserId?: string;
  displayName?: string;
};

const DEFAULT_CONFIG: RoomConfig = {
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
} as const;

type ConfigNumberKey = keyof typeof CONFIG_BOUNDS;

const MAX_OVERLAY_EVENTS = 30;
const MAX_REDEEM_LOG = 100;
const MAX_SOCKETS = 32;
const HOUR_MS = 3_600_000;

/**
 * One Durable Object = one channel's loyalty room.
 * Holds shared points state + overlay WebSocket clients.
 */
export class LoyaltyRoom {
  ctx: DurableObjectState;
  env: Env;
  state: RoomState | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      return this.acceptWebSocket();
    }

    await this.ensureState();
    const room = this.room();

    if (request.method === "POST" && url.pathname === "/touch") {
      const body = await readJsonRecord(request);
      const channelId = String(body.channelId || "").trim();
      if (!channelId) return json({ error: "channel_required" }, 400);
      room.lastChannelId = channelId;
      room.lastChannelAt = Date.now();
      await this.persist();
      return json({ ok: true, channelId });
    }

    if (request.method === "GET" && url.pathname === "/last") {
      return json({
        channelId: room.lastChannelId || null,
        updatedAt: room.lastChannelAt || null,
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
        config: room.config,
        wheelSegments: room.wheel.segments,
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
        config: room.config,
        activePoll: publicPoll(room.activePoll),
        wheelCooldownMs: remainingCooldown(
          room.wheel.lastSpinAt,
          room.config.wheelCooldownMs,
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
        activePoll: publicPoll(room.activePoll),
        wheelCooldownMs: remainingCooldown(
          room.wheel.lastSpinAt,
          room.config.wheelCooldownMs,
        ),
        lastRedeem: lastRedeemForUser(room.redeemLog, identity.userId),
      });
    }

    if (request.method === "GET" && url.pathname === "/me") {
      const identity = identityFromHeaders(request);
      if (!identity.userId) return json({ error: "unauthorized" }, 401);
      const viewer = this.upsertViewer(identity);
      return json({
        viewer: publicViewer(viewer),
        lastRedeem: lastRedeemForUser(room.redeemLog, identity.userId),
        activePoll: publicPoll(room.activePoll),
      });
    }

    if (request.method === "POST" && url.pathname === "/redeem") {
      const identity = identityFromHeaders(request);
      if (!identity.userId) return json({ error: "unauthorized" }, 401);
      const body = await readJsonRecord(request);
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
          room.wheel.lastSpinAt,
          room.config.wheelCooldownMs,
        );
        if (left > 0) {
          return json(
            {
              error: "cooldown",
              cooldownMs: left,
              viewer: publicViewer(room.viewers[identity.userId]),
            },
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

      if (
        !this.nowPlaying() &&
        ((reward.id === "shoutout" && room.config.autoPlayShoutouts) ||
          (reward.id === "wheel" && room.config.autoPlayWheel))
      ) {
        this.playRedeem(result.event.id);
      }

      await this.persist();
      this.broadcast();
      return json({
        ...result,
        activePoll: publicPoll(room.activePoll),
        wheelCooldownMs: remainingCooldown(
          room.wheel.lastSpinAt,
          room.config.wheelCooldownMs,
        ),
      });
    }

    if (request.method === "POST" && url.pathname === "/vote") {
      const identity = identityFromHeaders(request);
      const body = await readJsonRecord(request);
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
        redeems: room.redeemLog,
        nowPlaying: this.nowPlaying(),
        activeAlert: room.activeAlert,
        activePoll: room.activePoll,
        wheel: room.wheel,
      });
    }

    if (request.method === "POST" && url.pathname.startsWith("/admin/redeems/")) {
      const parts = url.pathname.split("/").filter(Boolean);
      const id = parts[2];
      const action = parts[3] || "";
      const body = await readJsonRecord(request);

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
          : this.finishRedeem(id, status as "done" | "rejected");

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
      const body = await readJsonRecord(request);
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
      await drainRequestBody(request);
      const id = url.pathname.split("/")[3];
      const result = this.closePoll(id);
      if (!result.ok) return json(result, result.error === "not_found" ? 404 : 400);
      await this.persist();
      this.broadcast();
      return json(result);
    }

    if (request.method === "POST" && url.pathname === "/admin/reset") {
      await drainRequestBody(request);
      this.state = freshState();
      await this.ctx.storage.deleteAlarm();
      await this.persist();
      this.broadcast();
      return json({ ok: true });
    }

    if (request.method === "PATCH" && url.pathname === "/admin/config") {
      const body = await readJsonRecord(request);
      for (const key of Object.keys(CONFIG_BOUNDS) as ConfigNumberKey[]) {
        const next = clampConfigNumber(key, body[key]);
        if (next !== null) room.config[key] = next;
      }
      for (const key of ["autoPlayShoutouts", "autoPlayWheel"] as const) {
        if (typeof body[key] === "boolean") room.config[key] = body[key];
      }
      if (body.alertMs && typeof body.alertMs === "object") {
        room.config.alertMs = {
          ...room.config.alertMs,
          ...(body.alertMs as Partial<RoomConfig["alertMs"]>),
        };
      }
      if (Array.isArray(body.wheelSegments) && body.wheelSegments.length >= 2) {
        room.wheel.segments = body.wheelSegments.map((s, i) => {
          const row = s && typeof s === "object" ? (s as Record<string, unknown>) : {};
          return {
            id: String(row.id || `seg${i}`),
            label: String(row.label || `Option ${i + 1}`),
            weight: Number(row.weight) || 1,
            color: typeof row.color === "string" ? row.color : undefined,
          };
        });
      }
      await this.persist();
      this.broadcast();
      return json({ config: room.config, wheel: room.wheel });
    }

    return json({ error: "not_found" }, 404);
  }

  async alarm(): Promise<void> {
    await this.ensureState();
    const room = this.room();
    const alert = room.activeAlert;
    if (alert?.endsAt && Date.now() >= alert.endsAt) {
      if (alert.redeemId) {
        const event = room.redeemLog.find((e) => e.id === alert.redeemId);
        if (event && event.status === "playing") {
          this.finishRedeem(event.id, "done");
        } else {
          room.activeAlert = null;
          if (room.wheel.pendingResult?.redeemId === alert.redeemId) {
            room.wheel.pendingResult = null;
          }
        }
      } else {
        room.activeAlert = null;
      }
      await this.persist();
      this.broadcast();
    }

    const poll = room.activePoll;
    if (poll?.status === "open" && poll.endsAt && Date.now() >= poll.endsAt) {
      this.closePoll(poll.id);
      await this.persist();
      this.broadcast();
    }

    await this.scheduleNextAlarm();
  }

  acceptWebSocket(): Response {
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

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    await this.ensureState();
    this.refreshPresence();
    this.clearExpiredAlert();
    _ws.send(JSON.stringify({ type: "overlay", data: this.overlayState() }));
  }

  webSocketClose(): void {}

  webSocketError(): void {}

  async ensureState(): Promise<void> {
    if (this.state) return;
    const saved = await this.ctx.storage.get("state");
    this.state = saved ? reviveState(saved) : freshState();
  }

  room(): RoomState {
    if (!this.state) throw new Error("LoyaltyRoom state not loaded");
    return this.state;
  }

  async persist(): Promise<void> {
    await this.ctx.storage.put("state", serializeState(this.room()));
    await this.scheduleNextAlarm();
  }

  async scheduleNextAlarm(): Promise<void> {
    const room = this.room();
    const times: number[] = [];
    if (room.activeAlert?.endsAt) times.push(room.activeAlert.endsAt);
    if (room.activePoll?.status === "open" && room.activePoll.endsAt) {
      times.push(room.activePoll.endsAt);
    }
    if (!times.length) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...times);
    await this.ctx.storage.setAlarm(next);
  }

  broadcast(): void {
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

  upsertViewer(identity: ViewerIdentity): Viewer {
    const room = this.room();
    let viewer = room.viewers[identity.userId];
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
      room.viewers[identity.userId] = viewer;
    } else {
      if (displayName) viewer.displayName = displayName;
      if (identity.opaqueUserId) viewer.opaqueUserId = identity.opaqueUserId;
    }
    return viewer;
  }

  heartbeat(userId: string, now = Date.now()) {
    const viewer = this.room().viewers[userId];
    if (!viewer) return { ok: false as const, error: "unknown_viewer" };

    const gap = now - viewer.lastHeartbeatAt;
    if (viewer.lastHeartbeatAt > 0 && gap < this.room().config.minHeartbeatGapMs) {
      return {
        ok: true as const,
        skipped: true as const,
        reason: "too_fast",
        viewer: publicViewer(viewer),
      };
    }

    if (!viewer.earnedWindowStart || now - viewer.earnedWindowStart >= HOUR_MS) {
      viewer.earnedWindowStart = now;
      viewer.earnedInWindow = 0;
    }
    const award = this.room().config.pointsPerTick;
    if (viewer.earnedInWindow + award > this.room().config.maxPointsPerHour) {
      viewer.lastHeartbeatAt = now;
      viewer.watching = true;
      return {
        ok: true as const,
        skipped: true as const,
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
      ok: true as const,
      skipped: false as const,
      awarded: award,
      viewer: publicViewer(viewer),
    };
  }

  redeem(input: {
    userId: string;
    type: string;
    payload?: Record<string, unknown>;
    cost: number;
  }) {
    const room = this.room();
    const viewer = room.viewers[input.userId];
    if (!viewer) return { ok: false as const, error: "unknown_viewer" };
    if (input.cost < 0) return { ok: false as const, error: "invalid_cost" };
    const now = Date.now();
    if (
      room.config.redeemCooldownMs > 0 &&
      viewer.lastRedeemAt &&
      now - viewer.lastRedeemAt < room.config.redeemCooldownMs
    ) {
      return {
        ok: false as const,
        error: "cooldown" as const,
        cooldownMs: remainingCooldown(
          viewer.lastRedeemAt,
          room.config.redeemCooldownMs,
        ),
        viewer: publicViewer(viewer),
      };
    }
    if (viewer.points < input.cost) {
      return {
        ok: false as const,
        error: "insufficient_points" as const,
        viewer: publicViewer(viewer),
      };
    }

    viewer.points -= input.cost;
    viewer.spentTotal += input.cost;
    viewer.lastRedeemAt = now;

    const event: RedeemEvent = {
      id: `r${++room.redeemSeq}`,
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

    room.redeemLog.unshift(event);
    if (room.redeemLog.length > MAX_REDEEM_LOG) {
      room.redeemLog.length = MAX_REDEEM_LOG;
    }

    this.pushOverlay({
      kind: "redeem",
      displayName: viewer.displayName,
      message: `${viewer.displayName} spent ${input.cost} pts · ${input.type}`,
    });

    return { ok: true as const, event, viewer: publicViewer(viewer) };
  }

  nowPlaying(): RedeemEvent | null {
    return this.room().redeemLog.find((e) => e.status === "playing") || null;
  }

  playRedeem(id: string) {
    const room = this.room();
    const event = room.redeemLog.find((e) => e.id === id);
    if (!event) return { ok: false as const, error: "not_found" };
    if (event.status === "playing") return { ok: true as const, event };
    if (event.status !== "queued") {
      return { ok: false as const, error: "not_queued", event };
    }

    const current = this.nowPlaying();
    if (current && current.id !== id) {
      return { ok: false as const, error: "already_playing", event: current };
    }

    event.status = "playing";
    event.playedAt = Date.now();

    if (event.type === "wheel") {
      const picked = pickWeightedSegment(room.wheel.segments);
      const segment = picked?.segment;
      const index = picked?.index ?? 0;
      event.result = {
        segmentId: segment?.id,
        label: segment?.label,
        index,
        color: segment?.color,
      };
      room.wheel.lastSpinAt = Date.now();
      room.wheel.pendingResult = {
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
      room.activeAlert = {
        redeemId: event.id,
        kind: "wheel",
        displayName: event.displayName,
        text: segment?.label || "Challenge",
        title: null,
        segmentIndex: index,
        segments: room.wheel.segments,
        startedAt: Date.now(),
        endsAt: Date.now() + spinMs + holdMs,
        spinMs,
      };
    } else if (event.type === "song") {
      const text = payloadText(event.payload);
      room.activeAlert = {
        redeemId: event.id,
        kind: "song",
        displayName: event.displayName,
        text,
        title: text || "Song request",
        startedAt: Date.now(),
        endsAt: null,
      };
    } else if (event.type === "tts") {
      const ms = room.config.alertMs.tts || 12000;
      room.activeAlert = {
        redeemId: event.id,
        kind: "tts",
        displayName: event.displayName,
        text: payloadText(event.payload),
        title: null,
        startedAt: Date.now(),
        endsAt: Date.now() + ms,
      };
    } else {
      const ms = room.config.alertMs.shoutout || 7000;
      room.activeAlert = {
        redeemId: event.id,
        kind: event.type === "shoutout" ? "shoutout" : event.type,
        displayName: event.displayName,
        text: payloadText(event.payload),
        title: null,
        startedAt: Date.now(),
        endsAt: Date.now() + ms,
      };
    }

    return { ok: true as const, event, activeAlert: room.activeAlert };
  }

  finishRedeem(id: string, status: "done" | "rejected") {
    const room = this.room();
    const event = room.redeemLog.find((e) => e.id === id);
    if (!event) return { ok: false as const, error: "not_found" };
    if (event.status === "done" || event.status === "rejected") {
      return { ok: true as const, event };
    }

    event.status = status;
    event.completedAt = Date.now();

    if (status === "rejected" && !event.refunded) {
      const viewer = room.viewers[event.userId];
      if (viewer) {
        viewer.points += event.cost;
        viewer.spentTotal = Math.max(0, viewer.spentTotal - event.cost);
      }
      event.refunded = true;
    }

    if (room.activeAlert?.redeemId === id) {
      room.activeAlert = null;
    }
    if (room.wheel.pendingResult?.redeemId === id) {
      room.wheel.pendingResult = null;
    }

    return { ok: true as const, event };
  }

  startPoll(body: Record<string, unknown>) {
    const room = this.room();
    if (room.activePoll?.status === "open") {
      return { ok: false as const, error: "poll_open" };
    }

    const question = String(body.question || "").trim();
    if (!question) return { ok: false as const, error: "question_required" };

    const rawOptions = Array.isArray(body.options) ? body.options : [];
    const options = rawOptions
      .map((o, i): PollOption => {
        const rec = o && typeof o === "object" ? (o as Record<string, unknown>) : null;
        return {
          id: String(rec?.id || `opt${i + 1}`),
          label: String(rec?.label || o || "").trim(),
          votes: 0,
        };
      })
      .filter((o) => o.label);

    if (options.length < 2 || options.length > 4) {
      return { ok: false as const, error: "options_2_to_4" };
    }

    const durationMs = Math.min(
      Math.max(Number(body.durationMs) || 60_000, 10_000),
      600_000,
    );

    const poll: Poll = {
      id: `p${++room.pollSeq}`,
      question,
      options,
      endsAt: Date.now() + durationMs,
      status: "open",
      voters: {},
      createdAt: Date.now(),
      closedAt: null,
    };
    room.activePoll = poll;
    this.pushOverlay({
      kind: "poll",
      displayName: "Poll",
      message: `Poll: ${question}`,
    });
    return { ok: true as const, poll: publicPoll(poll) };
  }

  closePoll(id: string) {
    const poll = this.room().activePoll;
    if (!poll || poll.id !== id) return { ok: false as const, error: "not_found" };
    if (poll.status === "closed") return { ok: true as const, poll: publicPoll(poll) };
    poll.status = "closed";
    poll.closedAt = Date.now();
    poll.endsAt = Date.now() + 10_000;
    return { ok: true as const, poll: publicPoll(poll) };
  }

  castVote(userId: string, optionId: string) {
    const room = this.room();
    const poll = room.activePoll;
    if (!poll || poll.status !== "open") {
      return { ok: false as const, error: "no_poll" };
    }
    if (poll.endsAt && Date.now() >= poll.endsAt) {
      this.closePoll(poll.id);
      return { ok: false as const, error: "poll_closed" };
    }
    if (poll.voters[userId]) {
      return {
        ok: false as const,
        error: "already_voted",
        poll: publicPoll(poll),
        viewer: publicViewer(room.viewers[userId]),
      };
    }
    const option = poll.options.find((o) => o.id === optionId);
    if (!option) return { ok: false as const, error: "bad_option" };

    poll.voters[userId] = { optionId, paidVotes: 0 };
    option.votes += 1;

    return {
      ok: true as const,
      poll: publicPoll(poll),
      viewer: publicViewer(room.viewers[userId]),
    };
  }

  clearExpiredAlert(): void {
    const room = this.room();
    const alert = room.activeAlert;
    if (alert?.endsAt && Date.now() >= alert.endsAt) {
      if (alert.redeemId) {
        const event = room.redeemLog.find((e) => e.id === alert.redeemId);
        if (event && event.status === "playing" && event.type !== "song") {
          this.finishRedeem(event.id, "done");
          return;
        }
      }
      room.activeAlert = null;
    }

    const poll = room.activePoll;
    if (poll?.status === "open" && poll.endsAt && Date.now() >= poll.endsAt) {
      this.closePoll(poll.id);
    } else if (
      poll?.status === "closed" &&
      poll.endsAt &&
      Date.now() >= poll.endsAt
    ) {
      room.activePoll = null;
    }
  }

  refreshPresence(now = Date.now()): void {
    for (const viewer of Object.values(this.room().viewers)) {
      if (
        viewer.watching &&
        now - viewer.lastHeartbeatAt > this.room().config.presenceTimeoutMs
      ) {
        viewer.watching = false;
      }
    }
  }

  overlayState() {
    const room = this.room();
    const watching = Object.values(room.viewers)
      .filter((v) => v.watching)
      .map(overlayViewer)
      .sort((a, b) => b.points - a.points);

    const leaderboard = Object.values(room.viewers)
      .map(overlayViewer)
      .sort((a, b) => b.points - a.points)
      .slice(0, 10);

    return {
      config: room.config,
      watching,
      leaderboard,
      recent: room.overlayEvents.slice(0, 10),
      queue: room.redeemLog
        .filter((e) => e.status === "queued")
        .slice(0, 20)
        .map(publicRedeem),
      nowPlaying: publicRedeem(this.nowPlaying()),
      activeAlert: room.activeAlert,
      activePoll: publicPoll(room.activePoll),
      wheel: {
        segments: room.wheel.segments,
        pendingResult: room.wheel.pendingResult,
        cooldownMs: remainingCooldown(
          room.wheel.lastSpinAt,
          room.config.wheelCooldownMs,
        ),
      },
    };
  }

  pushOverlay(partial: { kind: string; displayName: string; message: string }): void {
    const room = this.room();
    room.overlayEvents.unshift({
      id: `o${++room.overlaySeq}`,
      createdAt: Date.now(),
      ...partial,
    });
    if (room.overlayEvents.length > MAX_OVERLAY_EVENTS) {
      room.overlayEvents.length = MAX_OVERLAY_EVENTS;
    }
  }
}

function freshState(): RoomState {
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

function serializeState(state: RoomState): RoomState {
  return state;
}

function reviveState(saved: unknown): RoomState {
  const data =
    saved && typeof saved === "object" ? (saved as Partial<RoomState>) : {};
  const base = freshState();
  const config = { ...base.config, ...(data.config || {}) };
  for (const key of Object.keys(CONFIG_BOUNDS) as ConfigNumberKey[]) {
    const next = clampConfigNumber(key, config[key]);
    config[key] = next === null ? DEFAULT_CONFIG[key] : next;
  }
  config.alertMs = {
    ...base.config.alertMs,
    ...(data.config?.alertMs || {}),
  };
  return {
    ...base,
    ...data,
    config,
    viewers: data.viewers || {},
    redeemLog: data.redeemLog || [],
    overlayEvents: data.overlayEvents || [],
    activeAlert: data.activeAlert || null,
    activePoll: data.activePoll || null,
    wheel: {
      ...base.wheel,
      ...(data.wheel || {}),
      segments:
        data.wheel?.segments && data.wheel.segments.length >= 2
          ? data.wheel.segments
          : base.wheel.segments,
    },
  };
}

function clampConfigNumber(key: ConfigNumberKey, value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const bounds = CONFIG_BOUNDS[key];
  if (!bounds) return null;
  const [min, max] = bounds;
  return Math.min(max, Math.max(min, value));
}

function publicViewer(viewer: Viewer | null | undefined) {
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

function publicPoll(poll: Poll | null) {
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
    myVote: undefined as string | undefined,
  };
}

function remainingCooldown(lastAt: number, cooldownMs: number): number {
  if (!lastAt || !cooldownMs) return 0;
  return Math.max(0, lastAt + cooldownMs - Date.now());
}

function lastRedeemForUser(log: RedeemEvent[], userId: string): RedeemEvent | null {
  return log.find((e) => e.userId === userId) || null;
}

function overlayViewer(viewer: Viewer) {
  return {
    displayName: viewer.displayName,
    points: viewer.points,
    watching: viewer.watching,
    earnedTotal: viewer.earnedTotal,
    spentTotal: viewer.spentTotal,
  };
}

function publicRedeem(event: RedeemEvent | null) {
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

function identityFromHeaders(request: Request): ViewerIdentity {
  return {
    userId: sanitizeId(request.headers.get("X-Viewer-Id")),
    opaqueUserId: sanitizeId(request.headers.get("X-Viewer-Opaque-Id")) || undefined,
    displayName: sanitizeDisplayName(request.headers.get("X-Viewer-Name")) || undefined,
  };
}

async function identityFromRequest(request: Request): Promise<ViewerIdentity> {
  const identity = identityFromHeaders(request);
  const body = await readJsonRecord(request);
  const fromBody = sanitizeDisplayName(body.displayName);
  if (fromBody) identity.displayName = fromBody;
  return identity;
}

async function readJsonRecord(request: Request): Promise<Record<string, unknown>> {
  const body = await request.json().catch(() => ({}));
  if (!body || typeof body !== "object" || Array.isArray(body)) return {};
  return body as Record<string, unknown>;
}

/** workerd errors if a Durable Object returns before the request body is consumed. */
async function drainRequestBody(request: Request): Promise<void> {
  if (request.bodyUsed) return;
  await request.arrayBuffer().catch(() => undefined);
}

function payloadText(payload: Record<string, unknown> | undefined): string {
  return typeof payload?.text === "string" ? payload.text : "";
}
