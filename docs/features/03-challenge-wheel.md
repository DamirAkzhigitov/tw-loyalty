# Challenge / chaos wheel

**Priority:** 3  
**Status:** Not built  
**Depends on:** Redeem queue + overlay alerts (playback path)  
**Why:** Strongest “first custom toy” — Channel-Points-style chaos with our currency

---

## Goal

Viewer spends points → overlay spins a weighted wheel → result is a challenge the streamer must do. Cooldowns and weights prevent spam and keep outcomes fun.

---

## Proposed behavior

1. New reward `wheel` in the catalog (cost TBD, e.g. 80–150).
2. Redeem → queued (or auto-play if streamer enables it).
3. On Play: overlay shows wheel, spins with seeded RNG from DO, lands on a segment.
4. Overlay shows challenge card (“Do 10 push-ups”) until streamer marks Done.
5. Optional: streamer can re-spin once (moderation) without refund — product choice.

### Segment examples (editable by streamer later)

| Segment | Weight | Notes |
|---------|--------|-------|
| Easy challenge | 30 | Soft chaos |
| Hard challenge | 10 | Rare |
| Drink water | 20 | Safe filler |
| Viewer picks | 15 | Social |
| Nothing / “safe” | 15 | Relief valve |
| Super chaos | 5 | Very rare |

Weights are relative integers; DO picks via weighted random.

---

## Implementation plan

### Catalog (`rewards.js`)

```js
{ id: "wheel", label: "Chaos wheel", cost: 100, needsText: false }
```

### DO state

```js
wheel: {
  segments: [ { id, label, weight, color? } ],
  cooldownMs: 60_000,
  lastSpinAt: 0,
  pendingResult: null | { redeemId, segmentId, label, spunAt }
}
```

- On redeem: check per-user and global cooldown; enqueue.
- On play: compute result **server-side**, store `pendingResult`, broadcast `{ type: "wheel_spin", seed/result }`.
- Overlay animates to the server-chosen index (client must not pick the winner).

### Overlay

- Dedicated wheel layout (full or corner): canvas/CSS wheel + result card.
- Motion: spin → decelerate → land → hold challenge card.
- Hide or dim watching cards during spin if full-layout.

### Admin

- Edit segments/weights/costs without deploy (JSON in DO config).
- Enable/disable wheel live.
- Play / skip / complete like other redeems.

### Panel

- One button: “Chaos wheel”. Confirm with cost. No text field.
- Disable while on cooldown (“Ready in 0:42”).

---

## Open questions

1. Auto-play spins vs always require streamer Play?
2. Can the same viewer spin twice in a row if they can afford it?
3. Who authors the challenge list — hardcoded MVP vs admin editor day one?
4. Should “Nothing” segments refund a portion of points?
5. Record spins for “hall of shame” on overlay?

---

## Risks & constraints

- Client-side-only RNG is abusable / desyncs — always resolve on DO.
- Panel space: wheel is one button; do not add a segment browser in the panel.
- Long spin animations block other alerts — queue behind `nowPlaying`.

---

## Acceptance criteria

- [ ] Spend wheel deducts points and queues/plays a spin.
- [ ] Overlay animation lands on the server-selected segment.
- [ ] Cooldown enforced; clear error when blocked.
- [ ] Streamer can complete/dismiss the challenge card.
- [ ] Weights changeable via admin config without code edit (at least JSON PATCH).
