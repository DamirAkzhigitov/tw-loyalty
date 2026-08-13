# Overlay alerts for redeems

**Priority:** 2  
**Status:** Not built — overlay shows watching / leaderboard / tiny feed only  
**Depends on:** [01-redeem-queue-playback.md](./01-redeem-queue-playback.md) (at least shoutout → `playing`)  
**Related:** Wheel and poll get their own layouts later

---

## Goal

When someone spends, the stream should show a **big moment**, not only a feed line. Shoutout, TTS caption, and “now playing” song should be readable on camera and facecam-safe.

---

## Current state

- `public/overlay/` renders three cards: watching, leaderboard, recent feed.
- Empty lists already hide cards (`hidden` class) — good for broadcast.
- WS pushes full `overlay` snapshots from the DO.
- No dedicated alert layer, animation system, or `nowPlaying` UI.
- Query params: `channel`, `api`, `ws`, `scale`, `debug`.

---

## Proposed behavior

### Alert types

| Kind | Visual | Duration (default) |
|------|--------|--------------------|
| `shoutout` | Large name (+ optional message) | 6–8s |
| `tts` | Caption of spoken text + speaker name | While playing / max 15s |
| `song` | “Now playing” bar: title + requester | Until track ends or Done |
| `redeem` (generic) | Keep small feed for history | — |

Alerts stack behind a single **active** alert. New alert either waits or replaces lower-priority ones (shoutout can interrupt feed; do not interrupt song without skip).

### Layout modes

- **Broadcast (default):** hide room id; hide empty cards; alerts dominate when active.
- **Compact:** corner stack (facecam-safe) via `?layout=compact`.
- **Expanded:** larger leaderboard — optional later.
- Document OBS URL: `/overlay/?channel={id}`.

---

## Implementation plan

### Overlay (`public/overlay/`)

1. Add an `#alert` full/corner region above the cards.
2. On WS message, if `data.activeAlert` present → render alert template by `kind`.
3. Client-side timer: when `endsAt` passes, clear local alert if server has not already.
4. CSS: one composition language with existing overlay (avoid purple/glow AI defaults; match current stream-readable look).
5. Motion: enter (slide/fade), hold, exit — 2–3 intentional motions, not spam.
6. Optional local TTS: if `activeAlert.kind === "tts"` and `?tts=1`, call `speechSynthesis` (streamer opt-in).

### Durable Object

- Set `activeAlert` when admin **Play**s shoutout/TTS (or auto for shoutout).
- Clear on **complete** / timeout alarm (`ctx.storage.setAlarm` is available in DOs).
- Include `nowPlaying` for songs in overlay JSON.

### Config

- `alertMs.shoutout`, `alertMs.tts`, etc. via existing `PATCH /api/admin/config` expansion.

---

## Data model

```js
activeAlert: null | {
  redeemId: "r12",
  kind: "shoutout" | "tts" | "song",
  displayName: "Alice",
  text: "hello",       // optional
  title: "Song name",  // song
  startedAt: 123,
  endsAt: 456          // null if indefinite (song)
}
```

---

## Open questions

1. Full-bleed center vs corner for shoutouts? (Lean: corner by default, `?alert=center` for big moments.)
2. Should the feed duplicate the alert text, or stay quieter during alerts?
3. Do we play TTS audio inside OBS Browser Source or only show captions?
4. Safe area: document recommended OBS source size / safe margins for facecam.
5. Multi-language TTS voice selection?

---

## Risks & constraints

- Overlay must stay performant (OBS Browser Source can be heavy with video embeds).
- YouTube iframe in overlay is fragile (autoplay, login, ads) — prefer helper for music.
- Do not replace OBS overlay with a Twitch Overlay Extension unless that is an explicit product decision (`AGENTS.md`).

---

## Acceptance criteria

- [ ] Playing a shoutout shows a large on-stream name for ~N seconds.
- [ ] TTS play shows a readable caption.
- [ ] Song play shows now-playing until cleared.
- [ ] Empty watching/leaderboard/feed stay hidden on air.
- [ ] Room label hidden unless `debug=1`.
- [ ] Works with `/overlay/?channel=` pointed at local or deployed Worker.
