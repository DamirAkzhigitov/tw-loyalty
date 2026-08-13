# AGENTS.md

Guidance for anyone (human or agent) working in this repo.

## What this project is

**Twitch Loyalty** — a custom loyalty-points system for a small Twitch channel that is **not** using Bits.

Viewers see a **Twitch video overlay HUD** on the player while the stream is live (recommended), or an **Extension panel** below the player (alternate slot). The view heartbeats the backend (~1/s). Points accrue. Viewers spend them on stream moments (shoutout, TTS, song request). An **OBS Browser Source overlay** shows who is watching, the leaderboard, and a live spend feed.

This is **not** Twitch Channel Points and **not** Bits. Those need Affiliate/Partner and paid cheer. Our currency lives in our Worker.

Product direction and backlog: [`docs/improvements.md`](docs/improvements.md).

## Architecture

```text
Twitch channel page
  └── Video overlay HUD iframe → /video-overlay/  (earn + spend; live, default-visible)
  └── Extension panel iframe   → /panel/          (alternate desktop slot; also mobile)
         └── POST /api/viewer/*  (Extension JWT)

OBS
  └── Browser Source          → /overlay/  (not a Twitch Overlay Extension)
         └── GET /api/overlay + WS /ws

Cloudflare Worker (twitch-loyalty)
  ├── Auth (Extension JWT, or X-Dev-* headers when DEV_MODE=1)
  ├── Static assets from /public
  └── Durable Object LoyaltyRoom  — one instance per Twitch channel id
```

Workers are stateless. Shared points, presence, redeem queue, and overlay WebSockets live in the **Durable Object**. Free-plan DOs must use SQLite: `new_sqlite_classes` in `worker/wrangler.toml` (do not switch back to `new_classes`).

One Extension can occupy **only one desktop slot** at a time: Overlay **or** Panel (plus Mobile). Do not expect panel + video overlay to run together. Recommended live activation: **Overlay 1 + mobile** (`panel/index.html`).

## Layout

| Path | Role |
|------|------|
| `public/video-overlay/` | Twitch video overlay HUD (per-viewer iframe on the player) |
| `public/panel/` | Viewer Extension panel (~318×496); also used as Mobile view |
| `public/ext-shared/` | Shared Extension client (auth, heartbeat, redeem, poll) |
| `public/overlay/` | OBS overlay (on-stream visuals) |
| `worker/` | Worker + Durable Object |
| `docs/` | Plans and notes |
| `backend/` | Deprecated local Node prototype — do not extend |

## Commands

```bash
cd worker
npm install
npm run dev      # http://127.0.0.1:8787
npm run typecheck
npm run deploy   # https://twitch-loyalty.damir-cy.workers.dev
```

From repo root: `npm run dev` / `npm run deploy`. `npm run pack:extension` zips `panel`, `video-overlay`, `ext-shared`, `privacy`, and `config.html`.

Secrets: `worker/.dev.vars` (local, gitignored). Production: `npx wrangler secret put EXT_SECRET`. Never commit secrets.

## Local overlay in OBS

Do not deploy to iterate on overlay CSS. `npm run dev` serves `http://127.0.0.1:8787/overlay/` — use that URL as the OBS Browser Source. Overlay files auto-reload on localhost. Local DO state is separate from production; `?api=` + `?ws=` can point the local overlay at the deployed Worker if you need live viewers.

The Twitch HUD is a different URL: `http://127.0.0.1:8787/video-overlay/`. Do not point OBS at that path.

## Rooms (easy to get wrong)

- Browser `/panel/` or `/video-overlay/` without Twitch auth → **DevViewer** in room `local`.
- Real Extension → room `{channel_id}` from the JWT.
- OBS `/overlay/` with no `?channel=` follows the **last Extension room**, not `local`.
- Hosted Test views are on `*.ext-twitch.tv`; API must be the Worker URL, and that origin must be on Twitch **Allowlist for URL Fetching Domains**.
- After a deploy, refresh the Twitch channel so the HUD/panel heartbeats once, then refresh the OBS overlay.

Do not merge all traffic into `local` unless you are explicitly simplifying to a single-streamer hack.

## Auth

- Production: `Authorization: Bearer <Extension JWT>`, verify with `EXT_SECRET` (base64), `DEV_MODE=0`.
- Local/dev: `X-Dev-User-Id`, `X-Dev-Display-Name`, optional `X-Dev-Channel-Id`.
- JWT often has `opaque_user_id` and `channel_id`; `user_id` / display name only if identity is shared. Helix via `helixToken` is used to resolve display names when possible.
- `/api/admin/*` is open in local DEV_MODE only. Production requires `ADMIN_SECRET` via `X-Admin-Secret` (admin page: `/admin/?channel={id}&password={secret}`); if that secret is unset, admin is disabled.

## Conventions

- Keep the panel / HUD small and obvious: balance + a few spend actions. Do not turn it into a dashboard.
- The video overlay iframe must stay click-through except on the HUD (`pointer-events: none` on `body`, `auto` on `.hud`).
- New rewards go in `worker/src/rewards.ts` and must work as **queued** events until playback exists.
- OBS overlay is for on-stream visuals; the Extension HUD/panel is for clicking. Do not replace the OBS overlay with the Twitch HUD.
- Economy: 1 point/second is for testing. The video overlay loads for every web viewer on a live channel — live streams should use a slower rate, caps, and cooldowns (`docs/improvements.md`). Heartbeats must stay gated on visibility (`document.visibilityState` + `Twitch.ext.onVisibilityChanged`).
- Prefer Durable Object storage until a real DB is justified (history, analytics, multi-device).
- TypeScript in the Worker (`npm run typecheck`; Wrangler compiles on `dev`/`deploy`). Panel/HUD/OBS stay static HTML/CSS/JS for Twitch and OBS.

## Out of scope unless asked

- Bits-in-Extensions, Twitch review listing, Crowd Control–style game hooks.
- Cloning Sound Alerts / StreamElements.
- Video **component** view (Twitch windowed widget). Overlay is the default-visible type.
- Force-push, amending published history, or committing `.dev.vars` / `.env`.
