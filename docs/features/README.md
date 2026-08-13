# Feature implementation docs

Detailed plans for items in [`../improvements.md`](../improvements.md). Each doc covers goal, current state, proposed design, touch points in the repo, open questions, risks, and a suggested acceptance check.

These are planning notes, not a commitment to ship everything. Prefer the **Suggested build order** below over building the full shop at once.

## Suggested build order

| # | Feature | Doc |
|---|---------|-----|
| 1 | Redeem queue + TTS/song/shoutout playback | [01-redeem-queue-playback.md](./01-redeem-queue-playback.md) |
| 2 | Overlay alerts for redeems | [02-overlay-alerts.md](./02-overlay-alerts.md) |
| 3 | Challenge / chaos wheel | [03-challenge-wheel.md](./03-challenge-wheel.md) |
| 4 | Panel UI polish | [04-panel-ui-polish.md](./04-panel-ui-polish.md) |
| 5 | On-stream poll / vote | [05-poll-vote.md](./05-poll-vote.md) |
| 6 | Economy tuning | [06-economy-tuning.md](./06-economy-tuning.md) |
| 7 | Streamer / mod dashboard | [07-streamer-mod-ui.md](./07-streamer-mod-ui.md) |
| 8 | Highlight my message | [08-highlight-message.md](./08-highlight-message.md) |
| 9 | Sound / meme clips | [09-sound-meme-clips.md](./09-sound-meme-clips.md) |
| 10 | Overlay theme / color | [10-overlay-theme.md](./10-overlay-theme.md) |
| 11 | Queue a game / next activity | [11-activity-queue.md](./11-activity-queue.md) |
| 12 | Mini-game entry | [12-mini-games.md](./12-mini-games.md) |
| 13 | Technical hardening | [13-technical-hardening.md](./13-technical-hardening.md) |
| 14 | IRL / hardware (later) | [14-irl-hardware.md](./14-irl-hardware.md) |

## Architecture reminder

```text
Panel → POST /api/viewer/* → Worker → Durable Object (LoyaltyRoom)
OBS overlay → GET /api/overlay + WS /ws → same DO
Admin (future) → /api/admin/* → same DO
```

New rewards belong in `worker/src/rewards.js` and must work as **queued** events until playback exists. Shared state stays in the Durable Object until history/analytics justify D1.

## Doc template (for new features)

When adding a feature later, keep the same sections:

1. Goal
2. Current state
3. Proposed behavior
4. Implementation plan (Worker / DO / panel / overlay)
5. Data model & APIs
6. Open questions
7. Risks & constraints
8. Acceptance criteria
