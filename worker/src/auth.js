/**
 * Twitch Extension JWT auth.
 * In DEV_MODE, accepts X-Dev-User-Id headers so you can test without the Rig.
 */

const ALLOWED_HEADERS =
  "Content-Type, Authorization, X-Dev-User-Id, X-Dev-Display-Name, X-Dev-Channel-Id, X-Admin-Secret";

const BLOCKED_IDS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * @param {Request} request
 * @param {{ DEV_MODE?: string, EXT_SECRET?: string }} env
 */
export async function resolveIdentity(request, env) {
  const auth = request.headers.get("Authorization");
  if (auth?.startsWith("Bearer ")) {
    return verifyExtensionToken(auth.slice("Bearer ".length).trim(), env);
  }

  if (env.DEV_MODE !== "0") {
    const userId = sanitizeId(request.headers.get("X-Dev-User-Id"));
    if (userId) {
      return {
        userId,
        opaqueUserId: userId,
        displayName:
          sanitizeDisplayName(request.headers.get("X-Dev-Display-Name")) ||
          `Dev-${userId.slice(-4)}`,
        role: "viewer",
        channelId: sanitizeChannelId(request.headers.get("X-Dev-Channel-Id")),
        isDev: true,
      };
    }
  }

  return null;
}

/**
 * @param {Request} request
 * @param {{ DEV_MODE?: string, EXT_SECRET?: string }} env
 */
export async function requireViewer(request, env) {
  const identity = await resolveIdentity(request, env);
  if (!identity?.userId) {
    return {
      identity: null,
      error: json({ error: "unauthorized" }, 401),
    };
  }
  return { identity, error: null };
}

/**
 * Production admin is closed unless ADMIN_SECRET is set and sent.
 * Local DEV_MODE keeps admin open for testing.
 * @param {Request} request
 * @param {{ DEV_MODE?: string, ADMIN_SECRET?: string }} env
 */
export async function requireAdmin(request, env) {
  if (env.DEV_MODE !== "0") return null;
  const secret = env.ADMIN_SECRET;
  if (!secret) return json({ error: "forbidden" }, 403);
  const provided = request.headers.get("X-Admin-Secret") || "";
  if (!(await secretsEqual(provided, secret))) {
    return json({ error: "forbidden" }, 403);
  }
  return null;
}

/**
 * Minimal HS256 JWT verify for Twitch Extension tokens.
 * @param {string} token
 * @param {{ DEV_MODE?: string, EXT_SECRET?: string }} env
 */
async function verifyExtensionToken(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");

  const [headerB64, payloadB64, sigB64] = parts;
  let header;
  try {
    header = JSON.parse(b64UrlToString(headerB64));
  } catch {
    throw new Error("malformed token");
  }
  if (header.alg !== "HS256") throw new Error("bad token");

  const secretB64 = env.EXT_SECRET;
  if (!secretB64) throw new Error("EXT_SECRET is not configured");

  const key = await crypto.subtle.importKey(
    "raw",
    b64ToBytes(secretB64),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );

  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    b64UrlToBytes(sigB64),
    new TextEncoder().encode(`${headerB64}.${payloadB64}`),
  );
  if (!ok) throw new Error("bad signature");

  let claims;
  try {
    claims = JSON.parse(b64UrlToString(payloadB64));
  } catch {
    throw new Error("malformed token");
  }

  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== "number" || now >= claims.exp) {
    throw new Error("expired");
  }
  if (typeof claims.nbf === "number" && now < claims.nbf) {
    throw new Error("not yet valid");
  }

  return normalizeClaims(claims);
}

function claimString(value) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/**
 * @param {Record<string, unknown>} claims
 */
function normalizeClaims(claims) {
  const opaqueUserId = sanitizeId(claimString(claims.opaque_user_id));
  const twitchUserId = sanitizeId(claimString(claims.user_id));
  const userId = opaqueUserId || twitchUserId;

  if (!userId) throw new Error("token missing user id");

  return {
    userId,
    opaqueUserId: opaqueUserId || userId,
    twitchUserId: twitchUserId || undefined,
    displayName: sanitizeDisplayName(claims.preferred_username),
    role: typeof claims.role === "string" ? claims.role : "viewer",
    channelId: sanitizeChannelId(claimString(claims.channel_id)),
    isDev: false,
  };
}

/**
 * @param {unknown} body
 * @param {number} status
 */
export function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
    },
  });
}

/**
 * @param {Request} request
 */
export function corsPreflight(request) {
  return new Response(null, {
    status: 204,
    headers: corsHeaderMap(request),
  });
}

/**
 * @param {Request} request
 * @param {Response} response
 */
export function withCors(request, response) {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaderMap(request))) {
    headers.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * @param {Request} request
 */
function corsHeaderMap(request) {
  /** @type {Record<string, string>} */
  const headers = {
    "access-control-allow-headers": ALLOWED_HEADERS,
    "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
  };
  const origin = request.headers.get("Origin") || "";
  if (isAllowedOrigin(origin, request)) {
    headers["access-control-allow-origin"] = origin;
    headers.vary = "Origin";
  }
  return headers;
}

/**
 * @param {string} origin
 * @param {Request} request
 */
function isAllowedOrigin(origin, request) {
  if (!origin) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false;
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host === "127.0.0.1") return true;
  if (host.endsWith(".ext-twitch.tv") || host === "ext-twitch.tv") return true;
  if (host === "twitch.tv" || host.endsWith(".twitch.tv")) return true;
  try {
    if (host === new URL(request.url).hostname.toLowerCase()) return true;
  } catch {
    // ignore
  }
  return false;
}

export function sanitizeId(value) {
  const id = String(value || "").trim();
  if (!id || BLOCKED_IDS.has(id) || id.length > 128) return "";
  return id;
}

export function sanitizeChannelId(value) {
  const id = String(value || "").trim();
  if (!id || BLOCKED_IDS.has(id) || id.length > 64) return "";
  return id;
}

export function sanitizeDisplayName(value) {
  if (typeof value !== "string") return "";
  const cleaned = value.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  if (!cleaned) return "";
  return cleaned.slice(0, 25);
}

/**
 * @param {string} a
 * @param {string} b
 */
async function secretsEqual(a, b) {
  const enc = new TextEncoder();
  const left = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(a)),
  );
  const right = new Uint8Array(
    await crypto.subtle.digest("SHA-256", enc.encode(b)),
  );
  return crypto.subtle.timingSafeEqual(left, right);
}

function b64UrlToString(value) {
  return new TextDecoder().decode(b64UrlToBytes(value));
}

function b64UrlToBytes(value) {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const pad = "=".repeat((4 - (padded.length % 4)) % 4);
  return b64ToBytes(padded + pad);
}

function b64ToBytes(value) {
  const bin = atob(value);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
