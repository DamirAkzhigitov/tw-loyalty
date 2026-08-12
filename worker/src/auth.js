/**
 * Twitch Extension JWT auth.
 * In DEV_MODE, accepts X-Dev-User-Id headers so you can test without the Rig.
 */

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
    const userId = request.headers.get("X-Dev-User-Id");
    if (userId) {
      return {
        userId,
        opaqueUserId: userId,
        displayName:
          request.headers.get("X-Dev-Display-Name") ||
          `Dev-${userId.slice(-4)}`,
        role: "viewer",
        channelId: request.headers.get("X-Dev-Channel-Id") || undefined,
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
 * Minimal HS256 JWT verify for Twitch Extension tokens.
 * @param {string} token
 * @param {{ DEV_MODE?: string, EXT_SECRET?: string }} env
 */
async function verifyExtensionToken(token, env) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");

  const [headerB64, payloadB64, sigB64] = parts;
  const secretB64 = env.EXT_SECRET;

  if (!secretB64) {
    if (env.DEV_MODE === "0") throw new Error("EXT_SECRET is not configured");
    return normalizeClaims(JSON.parse(b64UrlToString(payloadB64)));
  }

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

  return normalizeClaims(JSON.parse(b64UrlToString(payloadB64)));
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
  const opaqueUserId = claimString(claims.opaque_user_id);
  const twitchUserId = claimString(claims.user_id);
  // Opaque id stays the wallet key so sharing identity does not create a second viewer.
  const userId = opaqueUserId || twitchUserId;

  if (!userId) throw new Error("token missing user id");

  return {
    userId,
    opaqueUserId: opaqueUserId || userId,
    twitchUserId: twitchUserId || undefined,
    displayName:
      typeof claims.preferred_username === "string"
        ? claims.preferred_username
        : undefined,
    role: typeof claims.role === "string" ? claims.role : "viewer",
    channelId: claimString(claims.channel_id) || undefined,
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
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "Content-Type, Authorization, X-Dev-User-Id, X-Dev-Display-Name, X-Dev-Channel-Id, X-Viewer-Name",
      "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    },
  });
}

export function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      "access-control-allow-origin": "*",
      "access-control-allow-headers":
        "Content-Type, Authorization, X-Dev-User-Id, X-Dev-Display-Name, X-Dev-Channel-Id, X-Viewer-Name",
      "access-control-allow-methods": "GET,POST,PATCH,OPTIONS",
    },
  });
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
