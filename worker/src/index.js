import { corsPreflight, json, requireViewer } from "./auth.js";
import { LoyaltyRoom } from "./loyalty-room.js";

export { LoyaltyRoom };

const REGISTRY_ROOM = "__registry";

/**
 * @param {Request} request
 * @param {Env} env
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsPreflight();
    }

    if (url.pathname === "/api/health") {
      return json({
        ok: true,
        mode: env.DEV_MODE === "0" ? "prod" : "dev",
        runtime: "cloudflare-workers",
      });
    }

    if (url.pathname === "/" && request.method === "GET") {
      return new Response(homeHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }

    if (url.pathname === "/ws") {
      const channelId = await resolveChannelId(env, url, request);
      const room = roomStub(env, channelId);
      return room.fetch(request);
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
  },
};

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
    const channelId = await resolveChannelId(env, url, request);
    return forward(env, channelId, path, request);
  }

  if (
    path === "/viewer/session" ||
    path === "/viewer/heartbeat" ||
    path === "/viewer/me" ||
    path === "/viewer/redeem"
  ) {
    let identity;
    try {
      const result = await requireViewer(request, env);
      if (result.error) return result.error;
      identity = result.identity;
    } catch (err) {
      return json(
        {
          error: "invalid_token",
          detail: err instanceof Error ? err.message : String(err),
        },
        401,
      );
    }

    const bodyText =
      request.method !== "GET" && request.method !== "HEAD"
        ? await request.text()
        : "";
    let body = {};
    try {
      body = bodyText ? JSON.parse(bodyText) : {};
    } catch {
      body = {};
    }

    const displayName =
      (typeof body.displayName === "string" && body.displayName.trim()) ||
      identity.displayName ||
      request.headers.get("X-Viewer-Name") ||
      request.headers.get("X-Dev-Display-Name") ||
      (await helixDisplayName(body, identity));

    const channelId =
      identity.channelId ||
      url.searchParams.get("channel") ||
      request.headers.get("X-Dev-Channel-Id") ||
      env.DEFAULT_CHANNEL ||
      "local";

    if (!identity.isDev && identity.channelId) {
      await rememberChannel(env, identity.channelId);
    }

    const doPath = path.replace(/^\/viewer/, "") || "/";
    const headers = new Headers(request.headers);
    headers.set("X-Viewer-Id", identity.userId);
    headers.set("X-Viewer-Opaque-Id", identity.opaqueUserId || identity.userId);
    if (displayName) headers.set("X-Viewer-Name", displayName);

    const init = { method: request.method, headers };
    if (bodyText) {
      init.body = JSON.stringify({ ...body, displayName: displayName || undefined });
    }

    return roomStub(env, channelId).fetch(
      new Request(new URL(doPath, "https://loyalty.internal"), init),
    );
  }

  return json({ error: "not_found" }, 404);
}

/**
 * Overlay without ?channel= follows the last Twitch Extension room,
 * not the browser DevViewer room.
 * @param {Env} env
 * @param {URL} url
 * @param {Request} request
 */
async function resolveChannelId(env, url, request) {
  const explicit =
    url.searchParams.get("channel") || request.headers.get("X-Dev-Channel-Id");
  if (explicit) return explicit;

  const res = await registryStub(env).fetch(
    new Request("https://loyalty.internal/last"),
  );
  const data = await res.json().catch(() => ({}));
  return data.channelId || env.DEFAULT_CHANNEL || "local";
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
 * @param {Record<string, unknown>} body
 * @param {{ userId: string, twitchUserId?: string }} identity
 */
async function helixDisplayName(body, identity) {
  const token = typeof body.helixToken === "string" ? body.helixToken : "";
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const twitchUserId =
    (typeof body.twitchUserId === "string" && body.twitchUserId.trim()) ||
    identity.twitchUserId ||
    "";
  if (!token || !clientId || !twitchUserId) return null;
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
      const name = data.data?.[0]?.display_name;
      if (typeof name === "string" && name.trim()) return name.trim();
    } catch {
      // try the other auth scheme
    }
  }
  return null;
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
    <li><a href="/privacy/">Privacy policy</a></li>
    <li><a href="/api/health">API health</a></li>
    <li><a href="/api/overlay">Overlay JSON</a></li>
  </ul>
</body></html>`;
}
