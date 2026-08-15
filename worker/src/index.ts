import {
  corsPreflight,
  json,
  requireAdmin,
  requireViewer,
  sanitizeChannelId,
  sanitizeDisplayName,
  withCors,
} from "./auth";
import { LoyaltyRoom } from "./loyalty-room";

export { LoyaltyRoom };

const REGISTRY_ROOM = "__registry";
const MAX_BODY_BYTES = 4096;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return corsPreflight(request);
    }

    const response = await handleRequest(request, env, url);
    if (url.pathname.startsWith("/api/")) return withCors(request, response);
    return response;
  },
};

async function handleRequest(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  if (url.pathname === "/api/health") {
    return json({
      ok: true,
      runtime: "cloudflare-workers",
      jwtConfigured: Boolean(env.EXT_SECRET),
    });
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

async function handleApi(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const path = url.pathname.replace(/^\/api/, "") || "/";

  if (path === "/overlay" || path === "/rewards") {
    const channelId = await resolveChannelId(env, url, request);
    const res = await forward(env, channelId, path, request);
    if (path !== "/overlay") return res;
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
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
    } catch (err) {
      const reason = err instanceof Error ? err.message : "";
      if (reason === "EXT_SECRET is not configured") {
        return json({ error: "ext_secret_missing" }, 503);
      }
      return json({ error: "invalid_token" }, 401);
    }

    let body: Record<string, unknown> = {};
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

    let channelId: string;
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
    const init: RequestInit = { method: request.method, headers };
    if (request.method !== "GET" && request.method !== "HEAD") {
      init.body = JSON.stringify(doBody);
    }

    return roomStub(env, channelId).fetch(
      new Request(new URL(doPath, "https://loyalty.internal"), init),
    );
  }

  return json({ error: "not_found" }, 404);
}

async function readJsonBody(
  request: Request,
): Promise<{ error: Response | null; body: Record<string, unknown> }> {
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
    const body = JSON.parse(bodyText) as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { error: null, body: {} };
    }
    return { error: null, body: body as Record<string, unknown> };
  } catch {
    return { error: null, body: {} };
  }
}

function viewerDoBody(
  path: string,
  body: Record<string, unknown>,
  displayName: string,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
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

async function resolveChannelId(
  env: Env,
  url: URL,
  request: Request,
): Promise<string> {
  const explicit = sanitizeChannelId(
    url.searchParams.get("channel") || request.headers.get("X-Dev-Channel-Id"),
  );
  if (explicit) return explicit;

  const res = await registryStub(env).fetch(
    new Request("https://loyalty.internal/last"),
  );
  const data = (await res.json().catch(() => ({}))) as { channelId?: unknown };
  return (
    sanitizeChannelId(data.channelId) || env.DEFAULT_CHANNEL || "local"
  );
}

async function rememberChannel(env: Env, channelId: string): Promise<void> {
  await registryStub(env).fetch(
    new Request("https://loyalty.internal/touch", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channelId }),
    }),
  );
}

function registryStub(env: Env) {
  return roomStub(env, REGISTRY_ROOM);
}

async function helixDisplayName(
  body: Record<string, unknown>,
  identity: { twitchUserId?: string },
): Promise<string> {
  const token = typeof body.helixToken === "string" ? body.helixToken : "";
  const clientId = typeof body.clientId === "string" ? body.clientId : "";
  const twitchUserId = identity.twitchUserId || "";
  if (!token || !clientId || !twitchUserId) return "";
  const url = `https://api.twitch.tv/helix/users?id=${encodeURIComponent(twitchUserId)}`;
  for (const scheme of ["Extension", "Bearer"] as const) {
    try {
      const res = await fetch(url, {
        headers: {
          "Client-Id": clientId,
          Authorization: `${scheme} ${token}`,
        },
      });
      if (!res.ok) continue;
      const data = (await res.json()) as {
        data?: Array<{ display_name?: string }>;
      };
      const name = sanitizeDisplayName(data.data?.[0]?.display_name);
      if (name) return name;
    } catch {
      // try the other auth scheme
    }
  }
  return "";
}

async function forward(
  env: Env,
  channelId: string,
  path: string,
  request: Request,
): Promise<Response> {
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = await request.arrayBuffer();
  }
  return roomStub(env, channelId).fetch(
    new Request(new URL(path, "https://loyalty.internal"), init),
  );
}

function roomStub(env: Env, channelId: string) {
  const id = env.LOYALTY.idFromName(`channel:${channelId}`);
  return env.LOYALTY.get(id);
}

function isOverlayPath(pathname: string): boolean {
  return pathname === "/overlay" || pathname.startsWith("/overlay/");
}

function withNoStore(res: Response): Response {
  const headers = new Headers(res.headers);
  headers.set("cache-control", "no-store, must-revalidate");
  headers.set("pragma", "no-cache");
  return new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

function homeHtml(): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Twitch Loyalty</title></head>
<body style="font-family:system-ui;padding:24px;line-height:1.5">
  <h1>Twitch Loyalty (Cloudflare Worker)</h1>
  <ul>
    <li><a href="/panel/">Extension panel</a></li>
    <li><a href="/video-overlay/">Twitch video overlay HUD</a></li>
    <li><a href="/overlay/">OBS overlay</a></li>
    <li><a href="/admin/">Streamer admin (queue / poll)</a></li>
    <li><a href="/privacy/">Privacy policy</a></li>
    <li><a href="/api/health">API health</a></li>
  </ul>
</body></html>`;
}
