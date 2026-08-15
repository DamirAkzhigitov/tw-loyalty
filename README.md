# Twitch Loyalty (Cloudflare Workers)

Custom loyalty points for your stream, hosted on **Cloudflare Workers**:

- **Twitch video overlay HUD** (`/video-overlay`) — small chip on the player while live; expand to earn + spend
- **Extension panel** (`/panel`) — alternate slot (cannot be active at the same time as the overlay)
- **Worker + Durable Object** — heartbeats, balances, redeems (no separate VPS)
- **OBS overlay** (`/overlay`) — watching list, leaderboard, spend feed (on-stream visuals, not a Twitch Overlay Extension)

## Why a Worker (and a Durable Object)?

Workers are **stateless** across requests — you can’t keep a global `Map` of points in Worker memory alone.

So we use:

| Piece | Role |
|---|---|
| **Worker** | HTTP routing, Twitch JWT / dev auth, static assets |
| **Durable Object** (`LoyaltyRoom`) | One room per channel — shared points, redeem queue, WebSockets |

That’s your “backend / worker” without managing a server. Still no SQL DB — DO storage holds state for now.

```text
Viewer HUD / panel  --heartbeat/redeem-->  Worker  -->  Durable Object (per channel)
OBS overlay         <-------- WebSocket --------------/
```

## Quick start

```bash
cd worker
npm install
npx wrangler login    # once — uses your Cloudflare account
npm run dev
```

Then open the URLs wrangler prints (`http://127.0.0.1:8787`):

- Video overlay HUD: `/video-overlay/`
- Panel: `/panel/`
- Second viewer: `/panel/?user=dev-2&name=Alice`
- Overlay (OBS Browser Source): `/overlay/`
- Health: `/api/health`

## Local overlay in OBS (no deploy)

Keep `npm run dev` running. Point the OBS **Browser Source** at the local Worker — not the `workers.dev` URL:

```text
http://127.0.0.1:8787/overlay/
```

Use `127.0.0.1`, not `localhost` (OBS on Windows often mishandles IPv6). Leave wrangler running while you edit `public/overlay/`. The overlay reloads itself when those files change.

Generate test names/points from a browser: `http://127.0.0.1:8787/panel/` or `http://127.0.0.1:8787/video-overlay/` (DevViewer in room `local`).

Local Durable Object state is **not** production. To preview overlay CSS against live Twitch viewers:

```text
http://127.0.0.1:8787/overlay/?api=https://twitch-loyalty.damir-cy.workers.dev/api&ws=wss://twitch-loyalty.damir-cy.workers.dev/ws
```

`?live=0` turns off auto-reload. `?scale=1.25` enlarges the overlay.

## Deploy

```bash
cd worker
npm run deploy
```

Optional secrets / vars:

```bash
npx wrangler secret put EXT_SECRET   # Twitch Extension secret (base64)
```

`wrangler.toml` ships `DEV_MODE = "0"`. Local `worker/.dev.vars` keeps `DEV_MODE=1` for the Rig-less panel / HUD.

Streamer admin: set a password, then open the dashboard:

```bash
npx wrangler secret put ADMIN_SECRET
```

```text
https://twitch-loyalty.damir-cy.workers.dev/admin/?channel=YOUR_CHANNEL_ID&password=THE_ADMIN_SECRET
```

Use your numeric Twitch channel id (same as the Extension JWT `channel_id`), not the login name. Locally, `http://127.0.0.1:8787/admin/?channel=local` works without a password.

## Twitch Extension

1. Create an Extension in the [Developer Console](https://dev.twitch.tv/console)
2. A version can ship **panel + video overlay + mobile**. Twitch lets a channel activate this Extension in **only one desktop slot** at a time (overlay **or** panel, plus mobile).
3. **Recommended live setup:** activate **Overlay 1**, not a panel slot. The HUD is visible by default when the stream is live. Point **Mobile** at `panel/index.html`.
4. Viewer views send the Extension JWT; Worker verifies with `EXT_SECRET`
5. Channel id from the JWT selects the Durable Object room
6. Identity Link needs a public Privacy Policy URL in Version Details:
   `https://twitch-loyalty.damir-cy.workers.dev/privacy/`

Do not confuse the Twitch video overlay HUD (`public/video-overlay/`) with the OBS Browser Source (`public/overlay/`). OBS is burned into the stream for everyone; the HUD is a per-viewer iframe on the player.

### Hosted Test

Twitch CDN serves the Extension HTML (`*.ext-twitch.tv`). The Worker is only the API.

1. **Capabilities → Allowlist for URL Fetching Domains** add:
   `https://twitch-loyalty.damir-cy.workers.dev`
2. Zip frontend files (`npm run pack:extension` → `twitch-extension.zip`) and upload.
   - Panel path: `panel/index.html`
   - Video overlay path: `video-overlay/index.html`
   - Mobile path: `panel/index.html`
3. Re-upload after any `public/panel/`, `public/video-overlay/`, or `public/ext-shared/` change — Hosted Test does not use the Worker’s HTML.
4. After upload: **deactivate the panel slot, activate Overlay 1**. Refresh the channel. The HUD only appears **while live**.

Without the allowlist, the browser blocks `fetch` to the Worker. If the view still calls `/api` on `ext-twitch.tv`, Twitch returns **403**.

## Spend catalog (MVP)

| Reward   | Cost | Notes |
|----------|------|-------|
| shoutout | 40   | Overlay feed |
| tts      | 60   | Queued (playback later) |
| song     | 120  | Queued (playback later) |

## API

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/viewer/session` | Register / load viewer |
| POST | `/api/viewer/heartbeat` | +points while watching |
| POST | `/api/viewer/redeem` | Spend points |
| GET | `/api/overlay` | Snapshot for OBS |
| WS | `/ws` | Live overlay updates |

## Project layout

```text
public/panel           Viewer Extension panel (alternate slot)
public/video-overlay   Twitch video overlay HUD (recommended live slot)
public/ext-shared      Shared Extension client (auth, heartbeat, redeem)
public/overlay         OBS Browser Source
worker/                Cloudflare Worker + Durable Object
backend/               Old local Node prototype (optional; unused)
```

## Notes

- Default economy: **1 point / second** while the HUD or panel is visible. Overlay loads for every web viewer on a live channel — slow the rate before a real stream.
- Admin routes (`/api/admin/*`) are open in local DEV_MODE only; production needs `ADMIN_SECRET`
- TTS / music playback is not wired yet (queue only)
