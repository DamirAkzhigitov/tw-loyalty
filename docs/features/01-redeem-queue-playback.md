# Redeem queue + TTS / song / shoutout playback

**Priority:** 1 (first after MVP queue-only spends)  
**Status:** Partially built — redeem creates `queued` events; no real playback yet  
**Depends on:** Existing `REWARDS` (`tts`, `song`, `shoutout`)  
**Unlocks:** Overlay alerts, wheel, any future “play on stream” reward

---

## Goal

Viewers already spend points and get “Queued”. Streamers (or mods) need to **see the queue**, **play / skip / reject**, and have TTS + song **actually happen on stream**. Rejected spends should refund points.

---

## Current state

| Piece | Today |
|-------|--------|
| Catalog | `worker/src/rewards.js` — shoutout 40, TTS 60, song 120 |
| Redeem | `POST /api/viewer/redeem` → DO `redeem()` deducts points, appends `redeemLog` with `status: "queued"` |
| Admin | `GET /api/admin/redeems`, `POST /api/admin/redeems/:id` with `{ status: "done" \| "rejected" }` — **no auth**, **no refund** on reject |
| Overlay | Feed line only (`spent N pts · type`); queue list is in overlay JSON but UI barely uses it |
| Playback | None — Twitch review copy explicitly says TTS/songs are not played |

---

## Proposed behavior

### Queue lifecycle

```text
queued → playing → done
       ↘ rejected (refund)
       ↘ skipped (treat as rejected or done without play — decide)
```

1. Viewer redeems → event enters `queued`.
2. Streamer/mod opens admin UI (or overlay “control” mode later).
3. **Play** → status `playing`; overlay/helper starts alert/audio/music.
4. When finished (timer, audio `ended`, or manual **Done**) → `done`.
5. **Reject** / **Skip** → `rejected`; refund `cost` to viewer; overlay may show nothing or a soft “skipped”.

Only one `playing` redeem at a time per channel (simple MVP). Optional later: parallel shoutout while song plays.

### Per reward

| Reward | Play meaning |
|--------|----------------|
| **Shoutout** | Overlay full/corner alert with display name (+ optional text later). Auto-`done` after N seconds. |
| **TTS** | Synthesize or speak `payload.text`; show caption on overlay; then `done`. |
| **Song** | Resolve URL/title; play via approved player after explicit Play; then `done`. Never autoplay untrusted media. |

---

## Implementation plan

### 1. Durable Object (`loyalty-room.js`)

- Extend redeem statuses: `queued | playing | done | rejected`.
- On reject: credit `viewer.points += event.cost`, decrement `spentTotal` (or track `refundedTotal`).
- Add admin actions: `play`, `skip`, `reject`, `complete` (or map existing PATCH to richer verbs).
- Enforce single `playing` item; return `409` if another is playing.
- Broadcast overlay state on every status change (already via `broadcast()`).
- Optional: `config.autoPlayShoutouts` boolean for hands-free shoutouts.

### 2. Worker API (`index.js` / admin routes)

- Keep forwarding `/api/admin/*` to DO.
- Lock admin before production (see [13-technical-hardening.md](./13-technical-hardening.md)).
- Suggested endpoints:

```http
GET  /api/admin/redeems?channel={id}
POST /api/admin/redeems/{id}/play
POST /api/admin/redeems/{id}/complete
POST /api/admin/redeems/{id}/reject   # refund
POST /api/admin/redeems/{id}/skip     # policy TBD
```

### 3. Minimal admin page (`public/admin/` or expand `config.html`)

- List queued + playing items (name, type, text, cost, age).
- Buttons: Play, Done, Reject.
- Channel selector / `?channel=` for local vs Extension room.
- Enough for one streamer; full dashboard is [07-streamer-mod-ui.md](./07-streamer-mod-ui.md).

### 4. Playback adapters (choose one path first)

| Path | Pros | Cons |
|------|------|------|
| **A. Overlay browser TTS + media** | No extra install; OBS already has Browser Source | Audio routing in OBS; autoplay policies; YouTube embedding friction |
| **B. Local helper** (Streamer.bot / small Electron / Node) | Reliable audio to Voicemeeter/OBS | Extra install for streamer |
| **C. Hybrid** | Overlay for visuals; helper for audio | Two pieces to maintain |

**Recommendation:** A for shoutout + Web Speech TTS demo; B when music needs to be reliable. Song should store `url` + `title` after a parse step; Play only after streamer confirms.

### 5. Content filters (ship with TTS/song)

- Length already capped (`maxLength`).
- Strip/block URLs for TTS if desired; allow URLs only for song.
- Banned-word list in DO config or Worker env.
- Reject at redeem time with clear error (points not taken).

### 6. Panel feedback

- After redeem: keep “Queued”.
- Optionally poll `/viewer/me` or include last redeem status so UI can show “Playing now” / “Rejected (refunded)”.

---

## Data model & APIs

### Redeem event (extend)

```js
{
  id: "r12",
  userId, displayName, type, cost, createdAt,
  payload: { text: "..." },      // TTS / song query / shoutout note
  status: "queued" | "playing" | "done" | "rejected",
  playedAt: null | number,
  completedAt: null | number,
  refunded: false
}
```

### Overlay payload additions

```js
{
  queue: [ /* queued only */ ],
  nowPlaying: null | RedeemEvent,
  activeAlert: null | { kind, displayName, text, endsAt }
}
```

---

## Open questions

1. **Skip vs reject:** Does skip refund? (Lean: skip = reject + refund; “done without play” is rare.)
2. **Song source:** Free-text title only, YouTube URL parse, Spotify link, or upload? MVP: text + optional URL; streamer plays manually if autoplay fails.
3. **TTS engine:** Browser `speechSynthesis`, ElevenLabs/cloud TTS, or Streamer.bot voice?
4. **Approval gate:** Auto-queue all TTS, or require approve-before-play for first live streams?
5. **Who can admin?** Broadcaster only vs mods (needs Twitch OAuth / role check).
6. **Should shoutouts auto-play** without clicking Play?

---

## Risks & constraints

- Free-plan DO storage is fine for a short queue; do not grow `redeemLog` unbounded (already capped at 100).
- Untrusted song URLs: never autoplay without queue + Play.
- OBS Browser Source audio must be enabled; document for the streamer.
- Admin API is open in DEV — must not ship production without a lock.
- Panel is 318×496 — do not put the queue UI there.

---

## Acceptance criteria

- [ ] Admin can list queued redeems for a channel.
- [ ] Play → overlay shows shoutout alert OR TTS caption/audio starts OR song Play is acknowledged.
- [ ] Reject refunds points; balance updates on next heartbeat/session.
- [ ] Completing a redeem removes it from `queue` / `nowPlaying`.
- [ ] Second Play while one is playing is rejected or queued behind.
- [ ] Hosted Test / review still works: “Queued” remains valid if streamer never opens admin.
