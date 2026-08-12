# Economy tuning

**Priority:** 6  
**Status:** Test economy only (`1` point / `1000` ms tick)  
**Depends on:** Admin config PATCH (exists); better with streamer UI  
**Why:** 3600 points/hour is fine for testing, too fast for live streams

---

## Goal

Make earning and spending feel fair on real streams: slower accrual, caps, cooldowns, refunds, optional first-open bonus. Keep knobs in DO config so streamers can tune without a deploy.

---

## Current state

```js
// loyalty-room.js DEFAULT_CONFIG
pointsPerTick: 1,
tickMs: 1000,           // effective ~1 pt/s if heartbeat keeps up
minHeartbeatGapMs: 800,
presenceTimeoutMs: 5000
```

- Admin can already PATCH those four numbers.
- No daily cap, no per-reward cooldown, no refunds, no multipliers.

---

## Proposed levers

| Lever | Purpose | MVP default (live) |
|-------|---------|---------------------|
| `pointsPerTick` + `tickMs` | Base rate | e.g. 1 pt / 6–12s (~5–10 / min) |
| `dailyEarnCap` | Stop infinite AFK farm | e.g. 500–2000 / day |
| `firstOpenBonus` | First-minute delight | e.g. 20–50 once / day |
| `cooldownMsByReward` | Stop TTS spam | TTS 30–60s; song 120s |
| `earningPaused` | BRB / ads | boolean |
| Refund on reject | Trust | always for rejected redeems |

Later (not required): sub/regular multipliers, watch-streak bonus, decay.

---

## Implementation plan

1. Extend `DEFAULT_CONFIG` + `PATCH /admin/config` allowlist.
2. Heartbeat: award only if under daily cap and `!earningPaused`; return reason when capped/paused.
3. Track `earnedToday` + `earnDayKey` (UTC or streamer timezone — decide).
4. Redeem: check `cooldownMsByReward[type]` vs last redeem time per user.
5. Reject path refunds (see [01](./01-redeem-queue-playback.md)).
6. Panel: show paused/capped status; show cooldown remaining on buttons.
7. Document recommended live presets in this file or `improvements.md`.

### Suggested presets

```js
// testing (current)
{ pointsPerTick: 1, tickMs: 1000 }

// live starter
{ pointsPerTick: 1, tickMs: 10000, dailyEarnCap: 1000, firstOpenBonus: 30 }
```

---

## Open questions

1. Cap timezone: UTC vs broadcaster local?
2. Does presence alone earn, or require visible panel only? (Today: panel heartbeat — keep that.)
3. Refund song after Play started but skipped mid-track?
4. Should costs scale with rate automatically, or stay fixed while rate changes?
5. Multipliers for subs — Twitch auth scope / badge check complexity worth it?

---

## Risks & constraints

- Changing rate mid-stream confuses viewers — show earn rate in panel.
- Caps need clear messaging or people think the app is broken.
- Do not require a real DB for daily caps; DO storage is enough for one channel.

---

## Acceptance criteria

- [ ] Live preset can be applied via admin config without deploy.
- [ ] Heartbeat respects pause + daily cap with explicit status reasons.
- [ ] Per-reward cooldowns block spam with clear errors.
- [ ] Rejected redeems refund when that path ships.
- [ ] Panel reflects rate, pause, and cooldown state.
