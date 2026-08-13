# Mini-game entry

**Priority:** 12  
**Status:** Not built  
**Depends on:** Solid earn/spend loop; overlay real estate  
**Why:** Retention between redeems — one toy done well before a suite

---

## Goal

Ship **one** mini-game viewers can enter from the panel (points or free ticket), with a side overlay view and a clear winner. Examples from research: fishing, race, trivia burst.

**Recommendation:** Start with a **trivia burst** or **fishing** — low animation risk, works for Just Chatting.

---

## Proposed behavior (trivia burst example)

1. Streamer starts round: 1 question, 4 answers, 20–30s.
2. Viewers spend `trivia` entry cost (or free) to lock an answer.
3. Overlay shows question + live lock counts (not correct answer).
4. Reveal → winners get point prize from pot or fixed bounty.
5. Cooldown until next round.

### Alternative: fishing

- Spend to cast; DO RNG rarity; overlay splash + catch card; cooldown.
- Closer to a spam-friendly toy; needs careful economy.

---

## Implementation plan

1. DO module or section `minigame` state machine: `idle | open | reveal | cooldown`.
2. Admin: start round with payload (question JSON / fishing config).
3. Panel: entry UI only while `open`.
4. Overlay: dedicated side panel; do not cover facecam.
5. Economy: entry cost + prize must not print infinite points (prize from pot of entries, or capped bounty funded by “house”).

---

## Open questions

1. Which single game first — trivia, fishing, or race?
2. House-funded prizes vs player pot?
3. Spectator mode for people who did not enter?
4. Persist all-time mini-game wins on leaderboard?

---

## Risks & constraints

- Scope creep into a game platform — one toy only.
- Animation-heavy races stress OBS Browser Source.
- RNG fairness must be server-side.

---

## Acceptance criteria

- [ ] Streamer can start and end one mini-game type.
- [ ] Entrants are charged (if paid) and recorded server-side.
- [ ] Overlay shows the round clearly; result is correct.
- [ ] Economy cannot be trivially farmed for net-positive points every round.
