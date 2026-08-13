import {
  corsPreflight,
  json,
  requireAdmin,
  requireViewer,
  sanitizeChannelId,
  sanitizeDisplayName,
  withCors,
} from "./auth.js";
import { LoyaltyRoom } from "./loyalty-room.js";

export { LoyaltyRoom };

const REGISTRY_ROOM = "__registry";
const MAX_BODY_BYTES = 4096;

/**
 * @param {Request} request
 * @param {Env} env
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    const response = await handleRequest(request, env, url);
    if (url.pathname.startsWith("/api/")) return withCors(request, response);
    return response;
  },
};

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 */
async function handleRequest(request, env, url) {
  if (url.pathname === "/api/health") {
    return json({ ok: true, runtime: "cloudflare-workers" });
  }

  if (url.pathname === "/" && request.method === "GET") {
    return new Response(homeHtml(), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  }

  if (url.pathname === "/ws") {
    const channelId = await resolveChannelId(env, url, request);
    return roomStub(env, channelId).fetch(request);
  }

  if (url.pathname.startsWith("/api/")) {
    return handleApi(request, env, url);
  }

  if (env.ASSETS) {
    const assetRes = await env.ASSETS.fetch(request);
    if (isOverlayPath(url.pathname)) return withNoStore(assetRes);
    return assetRes;
  }

  return json({ error: "not_found" }, 404);
}

/**
 * @param {Request} request
 * @param {Env} env
 * @param {URL} url
 */
async function handleApi(request, env, url) {
  const path = url.pathname.replace(/^\/api/, "") || "/";

  if (path === "/overlay" || path === "/rewards") {
    const channelId = await resolveChannelId(env, url, request);
    const res = await forward(env, channelId, path, request);
    if (path !== "/overlay") return res;
    const data = await res.json().catch(() => ({}));
    return json({ ...data, channelId }, res.status);
  }

  if (path.startsWith("/admin/")) {
    const denied = await requireAdmin(request, env);
    if (denied) return denied;
    const channelId = await resolveChannelId(env, url, request);
    return forward(env, channelId, path, request);
  }

  if (
    path === "/viewer/session" ||
    path === "/viewer/heartbeat" ||
    path === "/viewer/me" ||
    path === "/viewer/redeem" ||
    path === "/viewer/vote"
  ) {
    let identity;
    try {
      const result = await requireViewer(request, env);
      if (result.error) return result.error;
      identity = result.identity;
    } catch {
      return json({ error: "invalid_token" }, 401);
    }

    let body = {};
    if (request.method !== "GET" && request.method !== "HEAD") {
      const parsed = await readJsonBody(request);
      if (parsed.error) return parsed.error;
      body = parsed.body;
    }

    const displayName =
      identity.displayName ||
      (identity.isDev
        ? sanitizeDisplayName(request.headers.get("X-Dev-Display-Name"))
        : "") ||
      (await helixDisplayName(body, identity));

    let channelId;
    if (!identity.isDev) {
      channelId = identity.channelId;
      if (!channelId) return json({ error: "unauthorized" }, 401);
    } else {
      channelId =
        identity.channelId ||
        sanitizeChannelId(url.searchParams.get("channel")) ||
        sanitizeChannelId(request.headers.get("X-Dev-Channel-Id")) ||
        env.DEFAULT_CHANNEL ||
        "local";
    }

    if (!identity.isDev && identity.channelId) {
      await rememberChannel(env, identity.channelId);
    }

    const doPath = path.replace(/^\/viewer/, "") || "/";
    const headers = new Headers();
    headers.set("content-type", "application/json");
    headers.set("X-Viewer-Id", identity.userId);
    headers.set("X-Viewer-Opaque-Id", identity.opaqueUserId || identity.userId);
    if (displayName) headers.set("X-Viewer-Name", displayName);

    const doBody = viewerDoBody(path, body, displayName);
    const init = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = JSON.stringify(doBody);
    }

    return roomStub(env, channelId).fetch(
      new Request(new URL(doPath, "https://loyalty.internal"), init),
    );
  }

  return json({ error: "not_found" }, 404);
}

/**
 * @param {Request} request
 */
async function readJsonBody(request) {
  const declared = Number(request.headers.get("content-length") || "0");
  if (declared > MAX_BODY_BYTES) {
    return { error: json({ error: "payload_too_large" }, 413), body: {} };
  }
  const bodyText = await request.text();
  if (bodyText.length > MAX_BODY_BYTES) {
    return { error: json({ error: "payload_too_large" }, 413), body: {} };
  }
  if (!bodyText) return { error: null, body: {} };
  try {
    const body = JSON.parse(bodyText);
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { error: null, body: {} };
    }
    return { error: null, body };
  } catch {
    return { error: null, body: {} };
  }
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} body
 * @param {string} displayName
 */
function viewerDoBody(path, body, displayName) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (displayName) out.displayName = displayName;
  if (path === "/viewer/redeem") {
    if (typeof body.type === "string") out.type = body.type;
    if (typeof body.text === "string") out.text = body.text;
  }
  if (path === "/viewer/vote" && typeof body.optionId === "string") {
    out.optionId = body.optionId;
  }
  return out;
}

/**
 * Overlay without ?channel= follows the last Twitch Extension room,
 * not the browser DevViewer room.
 * @param {Env} env
 * @param {URL} url
 * @param {Request} request
 */
async function resolveChannelId(env, url, request) {
  const explicit = sanitizeChannelId(
    url.searchParams.get("channel") || request.headers.get("X-Dev-Channel-Id"),
  );
  if (explicit) return explicit;

  const res = await registryStub(env).fetch(
    new Request("https://loyalty.internal/last"),
  );
  const data = await res.json().catch(() => ({}));
  return (
    sanitizeChannelId(data.channelId) || env.DEFAULT_CHANNEL || "local"
  );
}

/**
 * @param {Env} env
 * @param {string} channelId
 */
async function rememberChannel(env, channelId) {
  await registryStub(env).fetch(
    new Request("https://loyalty.internal/touch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId }),
    }),
  );
}

/**
 * @param {Env} env
 */
function registryStub(env) {
  return roomStub(env, REGISTRY_ROOM);
}

/**
 * Helix lookup uses the JWT user_id only — never a client-supplied twitchUserId.
 * @param {Record<string, unknown>} body
 * @param {{ twitchUserId?: string }} identity
 */
async function helixDisplayName(body, identity) {
  const token = typeof body.helixToken === "string" ? body.helixToken : "";
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const twitchUserId = identity.twitchUserId || "";
  if (!token || !clientId || !twitchUserId) return "";
  const url = `https://api.twitch.tv/helix/users?id=${encodeURIComponent(twitchUserId)}`;
  for (const scheme of ["Extension", "Bearer"]) {
    try {
      const res = await fetch(url, {
        headers: {
          "Client-Id": clientId,
          Authorization: `${scheme} ${token}`,
        },
      });
      if (!res.ok) continue;
      const data = await res.json();
      const name = sanitizeDisplayName(data.data?.[0]?.display_name);
      if (name) return name;
    } catch {
      // try the other auth scheme
    }
  }
  return "";
}

/**
 * @param {Env} env
 * @param {string} channelId
 * @param {string} path
 * @param {Request} request
 */
function forward(env, channelId, path, request) {
  return roomStub(env, channelId).fetch(
    new Request(new URL(path, "https://loyalty.internal"), request),
  );
}

/**
 * @param {Env} env
 * @param {string} channelId
 */
function roomStub(env, channelId) {
  const id = env.LOYALTY.idFromName(`channel:${channelId}`);
  return env.LOYALTY.get(id);
}

function isOverlayPath(pathname) {
  return pathname === "/overlay" || pathname.startsWith("/overlay/");
}

function withNoStore(res) {
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store, must-revalidate");
  headers.set("pragma", "no-cache");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function homeHtml() {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Twitch Loyalty</title></head>
<body style="font-family:system-ui;padding:24px;line-height:1.5">
  <h1>Twitch Loyalty (Cloudflare Worker)</h1>
  <ul>
    <li><a href="/panel/">Extension panel</a></li>
    <li><a href="/overlay/">OBS overlay</a></li>
    <li><a href="/admin/">Streamer admin (queue / poll)</a></li>
    <li><a href="/privacy/">Privacy policy</a></li>
    <li><a href="/api/health">API health</a></li>
  </ul>
</body></html>`;
}
