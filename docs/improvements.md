# Improvement plans

Notes from the early research and MVP: custom loyalty points (not Bits), earned while the **Twitch Extension panel** is open, spent on stream moments, shown on an **OBS overlay**.

Bits stay optional. This system is meant to work with a small audience.

**Implementation docs** for each planned feature (how to build, open questions, acceptance checks): [`docs/features/`](./features/README.md).

## Current MVP

- Earn: **1 point / second** while the panel is visible (heartbeat).
- Spend (queued only, not played yet): shoutout, TTS, song request.
- Overlay: watching list, leaderboard, live feed.
- Backend: Cloudflare Worker + Durable Object per channel (no SQL DB yet).

---

## 1. Where viewers spend points

Ship **playback + moderation** for the three existing rewards first, then add new ones.

### Finish what is already in the catalog

| Reward | Cost (MVP) | Next step |
|--------|------------|-----------|
| On-screen shoutout | 40 | Full-screen or corner alert with name + optional short text |
| Voice message (TTS) | 60 | Read aloud on stream; length cap; bad-word filter; skip/approve queue |
| Play music | 120 | YouTube/Spotify (or URL) queue; streamer/mod approve before play |

Streamer (or a later mod dashboard) should see a **redeem queue**: play, skip, reject. Rejected spends can refund points.

### New spend ideas (from research)

Pick a few; do not dump the whole shop on a 318×496 panel.

| Idea | Why it works | Notes |
|------|----------------|-------|
| **Challenge / chaos wheel** | Redeem → spin on overlay → streamer must do the challenge | Strongest “first custom toy”; weights + cooldown |
| **Highlight my message** | Name + text on overlay for a few seconds | Cheaper than shoutout; good for lurkers |
| **Vote / poll ticket** | Spend to add weight, or free chat vote + paid extra votes | Custom bars on OBS beat native Twitch UI |
| **Sound / meme clip** | Instant reaction (Sound Alerts niche) | Keep a **small** curated list (5–10), not a huge library |
| **Change overlay theme / color** | Visible “I was here” | Time-boxed so it does not wreck the layout |
| **Queue a game / next activity** | Viewers steer the stream | Fits Just Chatting / variety |
| **Mini-game entry** | Fishing, race, trivia burst | One toy well before a suite |
| **IRL / hardware later** | Lights, fan, etc. | Fun but extra infra (Lumia / similar) |

**Suggested spend order**

1. Make TTS + song actually play (with a mod/streamer queue).
2. Challenge wheel (Channel-Points-style, but our currency).
3. On-stream poll with paid or free votes.
4. One chat mini-game if the loop feels dead between redeems.

---

## 2. UI improvements

Panel is a Twitch **panel**: about **318×496px**. Overlay is OBS, not a Twitch Overlay Extension.

### Extension panel

- Clear **first-minute action**: balance + 2–3 spend buttons, not a long list.
- Show **earn rate** (“+1 / sec while this panel is open”).
- Disable unaffordable rewards; show “need X more”.
- Confirm spend with cost + preview (TTS text, song title).
- After spend: “Queued” vs “Playing now”.
- Dark/light that matches Twitch; 10px inner padding; no flashing.
- Mobile: panel is the main UI for phones — large tap targets.
- Identity: show real Twitch display name when Helix/identity share works; avoid `User-xxxx` when possible.
- Optional: “Share identity” prompt so names look human on the overlay.

### OBS overlay

- Shoutout / TTS / song as **big moments**, not only a tiny feed line.
- Wheel and poll as dedicated layouts (full or corner).
- Hide empty states during stream (no “Nobody watching yet” on air).
- Compact vs expanded layout (facecam-safe).
- OBS URL: `/overlay/?channel={id}` documented; room label only for debug (hide in “broadcast” mode).

### Streamer / mod UI (not built)

- Queue of TTS/songs/wheel spins.
- Enable/disable rewards live.
- Pause earning (BRB / ads).
- Tune costs without a deploy.

---

## 3. More interactivity

Goal: viewer acts → stream reacts in seconds. Lurkers should have a button, not only chat.

| Loop | Viewer action | On stream |
|------|----------------|-----------|
| Presence | Keep panel open | Name on “watching” + points tick |
| Voice | Spend TTS | Audio + overlay caption |
| Music | Spend song | Track plays after approve |
| Chaos | Spend wheel | Overlay spin + challenge card |
| Decide | Vote / poll | Animated bars |
| Compete | Mini-game | Side overlay + leaderboard |
| Be seen | Shoutout / avatar later | Face of the community |

**Do later / crowded**

- Full Sound Alerts / Blerp clone.
- Crowd Control–style in-game cheats (game-specific, heavy).
- Bits catalog (needs Extension review + Bits policy). Useful after the free-points loop is fun.

**Retention heuristic:** one meaningful action in the first 60 seconds (sound, vote, or cheap shoutout).

---

## 4. Economy

- **1 point / second** is fast (3600/hour). Fine for testing; for live streams consider **1–10 / minute**, daily caps, and first-open bonus.
- Cooldowns per reward and per user (TTS spam).
- Sub / regular multipliers later — not required for MVP.
- Refund on rejected song/TTS.

---

## 5. Technical follow-ups

- **`EXT_SECRET`** + `DEV_MODE=0` in production; verify Extension JWTs.
- Lock **`/api/admin/*`** (shared secret or streamer OAuth).
- Durable Object is enough for one channel; **D1/SQLite** if we need history, analytics, or multi-device recovery beyond DO storage.
- TTS: Worker queues → overlay or a local helper (Streamer.bot / browser TTS) plays audio.
- Music: store URL + title; never autoplay untrusted audio without a queue.
- Filter TTS/song text (length, links, banned words).
- Overlay and panel must stay on the **same channel room** (already: last Twitch Extension room, not DevViewer `local`).

---

## Suggested build order

1. Play TTS and song from the queue (even if streamer clicks “Play” in a simple admin page) — [doc](./features/01-redeem-queue-playback.md).
2. Overlay alerts that match those redeems — [doc](./features/02-overlay-alerts.md).
3. Challenge wheel spend + overlay spin — [doc](./features/03-challenge-wheel.md).
4. Panel UI polish (costs, disabled state, queued feedback) — [doc](./features/04-panel-ui-polish.md).
5. Poll / vote — [doc](./features/05-poll-vote.md).
6. Economy tuning after a few real streams — [doc](./features/06-economy-tuning.md).
7. Public Extension listing / Bits only if we want directory distribution.

Full list (including later toys, admin UI, hardening): [`docs/features/README.md`](./features/README.md).
