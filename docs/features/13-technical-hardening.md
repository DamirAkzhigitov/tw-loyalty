# Technical hardening

**Priority:** 13 (parallel — do auth before calling the system production)  
**Status:** Partial — JWT verify exists; admin open; filters missing  
**Depends on:** None  
**Why:** Safe live use, Extension review credibility, multi-session durability

---

## Goal

Close the gaps called out in `docs/improvements.md` §5: production auth, locked admin, content filters, clear room routing, and a path to D1 only when DO storage is not enough.

---

## Work items

### 1. Production Extension auth

| Setting | Target |
|---------|--------|
| `EXT_SECRET` | Set via `wrangler secret put` (base64 secret from Twitch) |
| `DEV_MODE` | `"0"` in production |

- Keep `X-Dev-*` headers ignored when `DEV_MODE=0`.
- Verify JWT on all `/api/viewer/*` routes (already via `requireViewer`).
- Confirm Hosted Test allowlist still includes Worker origin.

### 2. Lock `/api/admin/*`

Options (pick one):

1. **Shared secret** — `ADMIN_SECRET` env; require `X-Admin-Secret` or `Authorization: Bearer`.
2. **Streamer OAuth** — Twitch login; allow broadcaster user id (+ mods later).

MVP recommendation: shared secret. Document rotation. Reject all admin routes in prod if secret unset.

Also gate: `POST /admin/reset`, config PATCH, redeem moderation, future poll start.

### 3. Content filters

- Apply on redeem for `tts`, `song`, `highlight`, `activity`.
- Rules: length (exists), ban list, optional link policy (block in TTS; allow in song).
- Config: `bannedWords: string[]` in DO config or env JSON.
- Return `400` with `error: "text_blocked"` before charging points.

### 4. Room routing discipline

Already documented in `AGENTS.md`:

- Browser panel without Twitch → `local`.
- Real Extension → JWT `channel_id`.
- Overlay without `?channel=` → last Extension room, not `local`.

Hardening tasks:

- Admin UI forces explicit `channel`.
- Overlay broadcast mode hides room id.
- Optional: refuse overlay “guess” when no room touched recently.

### 5. Persistence upgrade path (later)

Stay on Durable Object storage until you need:

- Long redeem history / analytics
- Multi-device recovery beyond DO
- Cross-channel reporting

Then: **D1** or DO SQLite tables (`new_sqlite_classes` already required on free plan). Do not switch wrangler back to `new_classes`.

### 6. Playback security

- Never autoplay untrusted song URLs without queue + Play.
- Prefer allowlisted hosts if embedding (YouTube only, etc.).

---

## Implementation plan (auth secret example)

```js
// index.js before forward admin
if (env.DEV_MODE === "0") {
  const secret = env.ADMIN_SECRET;
  if (!secret || request.headers.get("X-Admin-Secret") !== secret) {
    return json({ error: "unauthorized" }, 401);
  }
}
```

Local: put `ADMIN_SECRET` in `worker/.dev.vars` (gitignored).

---

## Open questions

1. Secret vs OAuth for v1 live streams?
2. Central ban list vs per-channel lists?
3. When is D1 actually justified — after N streams? After exporting stats?
4. Should `/api/overlay` remain world-readable? (Usually yes for OBS; it leaks display names + points.)

---

## Risks & constraints

- Locking admin without documenting the secret breaks the streamer’s workflow.
- Over-filtering TTS kills fun — start with severe terms only.
- World-readable overlay JSON is acceptable for a small channel; revisit if abused.

---

## Acceptance criteria

- [ ] `DEV_MODE=0` rejects dev header auth.
- [ ] Admin routes unauthorized without secret/OAuth.
- [ ] Banned text cannot be purchased.
- [ ] Overlay/panel still agree on the same channel room in the documented setups.
- [ ] No secrets committed; `.dev.vars` stays gitignored.
