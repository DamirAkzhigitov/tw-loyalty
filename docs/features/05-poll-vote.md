# On-stream poll / vote

**Priority:** 5  
**Status:** Not built  
**Depends on:** Overlay alert patterns; optional paid votes need economy cooldowns  
**Why:** Custom OBS bars beat native Twitch poll UI for branded chaos

---

## Goal

Streamer starts a poll → viewers vote from the panel (free and/or paid extra weight) → overlay shows animated bars. Ends on timer or manual close; result stays on screen briefly.

---

## Proposed behavior

### Modes (pick one for MVP)

| Mode | Viewer action | Notes |
|------|---------------|--------|
| **A. Free panel vote** | Tap option once | Simplest; anti-spam: 1 vote / poll / user |
| **B. Paid vote ticket** | Spend points per vote | Can buy multiple; cost e.g. 10–25 |
| **C. Hybrid** | Free 1 vote + paid extras | Best retention; slightly more UI |

**Recommendation:** A first, then add paid multiplier as reward `vote` or inline “Add weight · 15 pts”.

### Flow

1. Admin: create poll `{ question, options[2..4], durationMs }`.
2. DO stores `activePoll`; broadcasts to overlay + panel session/heartbeat.
3. Panel shows poll card when active; otherwise hides.
4. Vote → update tallies; broadcast throttled (e.g. every 200ms coalesce).
5. Close → `closed` result on overlay 10s → clear.

---

## Implementation plan

### DO

```js
activePoll: null | {
  id, question, options: [{ id, label, votes }],
  costPerExtraVote: 0 | number,
  endsAt, status: "open" | "closed",
  voters: { [userId]: { optionId, paidVotes } }
}
```

- Endpoints: `POST /admin/polls`, `POST /admin/polls/:id/close`, `POST /viewer/vote`.
- Persist tallies; do not trust client totals.

### Panel

- When `activePoll` in session/heartbeat: show question + option buttons.
- After vote: show checkmark / your choice; allow paid extra if enabled.
- Must remain compact (one job while poll is live).

### Overlay

- Dedicated poll layout: question + animated bars + percentages.
- Motion: bar width transitions; subtle settle on close.

---

## Open questions

1. Free-only MVP or hybrid from day one?
2. Can viewers change their free vote before close?
3. Chat voting via bot later, or panel-only forever?
4. Max options 3 or 4 for overlay readability?
5. Should poll block other alerts or sit in a corner?

---

## Risks & constraints

- Heartbeat spam + vote spam: rate-limit votes.
- Panel real estate: poll replaces or sits above spend buttons temporarily.
- Opaque users without identity still need stable `userId` for one-vote rule (already true).

---

## Acceptance criteria

- [ ] Streamer can open a 2–4 option poll with a duration.
- [ ] Each viewer can cast the allowed votes; tallies match DO state.
- [ ] Overlay bars update live and show final result.
- [ ] Poll disappears from panel when closed.
- [ ] Paid votes (if enabled) deduct points and increase weight.
