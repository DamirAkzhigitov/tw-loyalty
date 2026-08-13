# Queue a game / next activity

**Priority:** 11  
**Status:** Not built  
**Depends on:** Redeem queue; streamer UI nice-to-have  
**Why:** Viewers steer Just Chatting / variety streams

---

## Goal

Viewers spend points to add an activity to a streamer-facing queue (“Play Cuphead”, “IRL walk”, “Q&A”). Streamer pulls from the list when ready. Not auto-starting software — social queue only for MVP.

---

## Proposed behavior

- Reward `activity`: needs text (activity name), cost mid-tier (e.g. 100), max length ~60.
- Goes to `activityQueue` (separate from TTS/song media queue, or unified with a `type`).
- Admin marks `done` / `rejected` (refund).
- Overlay optional: “Up next” card showing top 1–3 activities.

---

## Implementation plan

1. Add reward + filters (no links/spam).
2. Either reuse `redeemLog` with type `activity` or dedicated list for clarity.
3. Admin queue section: activities vs media.
4. Overlay “Up next” compact module; hide when empty.
5. Cooldown / max pending per user (e.g. 1 active request).

---

## Open questions

1. Freeform text vs picker from streamer-defined activity list?
2. Duplicate activities: merge votes/weights or allow dupes?
3. Show on overlay always, or only when streamer enables “planning mode”?

---

## Risks & constraints

- Freeform text invites trolls — prefer curated list when possible.
- Do not promise Crowd Control–style game hooks (`AGENTS.md`).

---

## Acceptance criteria

- [ ] Viewer can queue an activity for points.
- [ ] Streamer can complete/reject with refund on reject.
- [ ] Optional overlay shows upcoming activities when non-empty.
- [ ] Per-user pending limit enforced.
