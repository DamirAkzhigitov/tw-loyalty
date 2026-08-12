# AGENTS.md

Guidance for anyone (human or agent) working in this repo.

## What this project is

**Twitch Loyalty** — a custom loyalty-points system for a small Twitch channel that is **not** using Bits.

Viewers open a **Twitch Extension panel** while watching. The panel heartbeats the backend (~1/s). Points accrue. Viewers spend them on stream moments (shoutout, TTS, song request). An **OBS Browser Source overlay** shows who is watching, the leaderboard, and a live spend feed.

This is **not** Twitch Channel Points and **not** Bits. Those need Affiliate/Partner and paid cheer. Our currency lives in our Worker.

Product direction and backlog: [`docs/improvements.md`](docs/improvements.md).

## Architecture

```text
Twitch channel page
  └── Extension panel iframe  →  /panel/   (earn + spend UI)
         └── POST /api/viewer/*  (Extension JWT)

OBS
  └── Browser Source          →  /overlay/  (not a Twitch Overlay Extension)
         └── GET /api/overlay + WS /ws

Cloudflare Worker (twitch-loyalty)
  ├── Auth (Extension JWT, or X-Dev-* headers when DEV_MODE=1)
  ├── Static assets from /public
  └── Durable Object LoyaltyRoom  — one instance per Twitch channel id
```

Workers are stateless. Shared points, presence, redeem queue, and overlay WebSockets live in the **Durable Object**. Free-plan DOs must use SQLite: `new_sqlite_classes` in `worker/wrangler.toml` (do not switch back to `new_classes`).

## Layout

| Path | Role |
|------|------|
| `public/panel/` | Viewer Extension UI (Twitch panel ~318×496) |
| `public/overlay/` | OBS overlay |
| `worker/` | Worker + Durable Object |
| `docs/` | Plans and notes |
| `backend/` | Deprecated local Node prototype — do not extend |

## Commands

```bash
cd worker
npm install
npm run dev      # http://127.0.0.1:8787
npm run deploy   # https://twitch-loyalty.damir-cy.workers.dev
```

From repo root: `npm run dev` / `npm run deploy`.

Secrets: `worker/.dev.vars` (local, gitignored). Production: `npx wrangler secret put EXT_SECRET`. Never commit secrets.

## Local overlay in OBS

Do not deploy to iterate on overlay CSS. `npm run dev` serves `http://127.0.0.1:8787/overlay/` — use that URL as the OBS Browser Source. Overlay files auto-reload on localhost. Local DO state is separate from production; `?api=` + `?ws=` can point the local overlay at the deployed Worker if you need live viewers.

## Rooms (easy to get wrong)

- Browser `/panel/` without Twitch auth → **DevViewer** in room `local`.
- Real Extension → room `{channel_id}` from the JWT.
- Overlay `/overlay/` with no `?channel=` follows the **last Extension room**, not `local`.
- Hosted Test panel is on `*.ext-twitch.tv`; API must be the Worker URL, and that origin must be on Twitch **Allowlist for URL Fetching Domains**.
- After a deploy, refresh the Twitch channel so the panel heartbeats once, then refresh the overlay.

Do not merge all traffic into `local` unless you are explicitly simplifying to a single-streamer hack.

## Auth

- Production: `Authorization: Bearer <Extension JWT>`, verify with `EXT_SECRET` (base64), `DEV_MODE=0`.
- Local/dev: `X-Dev-User-Id`, `X-Dev-Display-Name`, optional `X-Dev-Channel-Id`.
- JWT often has `opaque_user_id` and `channel_id`; `user_id` / display name only if identity is shared. Helix via `helixToken` is used to resolve display names when possible.
- `/api/admin/*` is open in local DEV_MODE only. Production requires `ADMIN_SECRET` via `X-Admin-Secret`; if that secret is unset, admin is disabled.

## Conventions

- Keep the panel small and obvious: balance + a few spend actions. Do not turn it into a dashboard.
- New rewards go in `worker/src/rewards.js` and must work as **queued** events until playback exists.
- Overlay is for on-stream visuals; the Extension **panel** is for clicking. Do not replace the OBS overlay with a Twitch Overlay Extension unless that is an explicit product decision.
- Economy: 1 point/second is for testing. Live streams should use a slower rate, caps, and cooldowns (`docs/improvements.md`).
- Prefer Durable Object storage until a real DB is justified (history, analytics, multi-device).
- JavaScript modules in the Worker (no extra bundler). Panel/overlay are static HTML/CSS/JS.

## Out of scope unless asked

- Bits-in-Extensions, Twitch review listing, Crowd Control–style game hooks.
- Cloning Sound Alerts / StreamElements.
- Force-push, amending published history, or committing `.dev.vars` / `.env`.
