# Panel UI polish

**Priority:** 4  
**Status:** Partial — basic balance + reward buttons + text form  
**Depends on:** None (can ship anytime); benefits from queue status later  
**Constraint:** Twitch panel ≈ **318×496px**

---

## Goal

Make the first minute obvious: show balance, earn rate, 2–3 spend actions, disable what you cannot afford, confirm with preview, and feedback after spend (“Queued” vs “Playing now”). Keep it a small loyalty pad, not a dashboard.

---

## Current state

- `public/panel/` — session, heartbeat ~1s, redeem form for text rewards.
- Rewards rendered as buttons from server catalog.
- Identity via Extension helper + Helix display name when possible.
- No earn-rate copy, no “need X more”, limited disabled-state UX, no playing status.

---

## Proposed behavior

### First viewport (always)

1. Display name (human when identity shared).
2. Points balance (large).
3. One line: earn rate, e.g. `+1 / sec while this panel is open` (driven by `config.pointsPerTick` + `tickMs`).
4. 2–3 primary spend buttons (shoutout / TTS / song or later wheel). Hide overflow behind “More” only if catalog grows.

### Affordability

- If `points < cost`: button disabled + subtitle `Need {cost - points} more`.
- Re-enable as heartbeats accrue (already re-renders on heartbeat).

### Confirm

- TTS/song: existing form with cost in confirm button (`Confirm · 60`).
- Preview truncated text.
- Cancel dismisses without charge.

### After spend

- Status: `Queued: Voice message` → later `Playing` / `Rejected · refunded` if panel learns status (poll redeem id or include in heartbeat payload).

### Visual / a11y

- Match Twitch dark/light if detectable; else dark default that fits Twitch.
- ~10px inner padding; large tap targets for mobile.
- No flashing; respect reduced-motion when easy.
- Optional “Share identity” prompt when names look like `User-xxxx`.

---

## Implementation plan

1. `panel.js`: compute disabled + need-more from `viewer.points` and reward cost.
2. Show earn rate from session `config`.
3. Confirm button label includes cost.
4. Keep catalog-driven rendering — do not hardcode three buttons if avoidable.
5. CSS: tighten hierarchy; avoid card soup; one composition.
6. Optional: heartbeat response includes `lastRedeem` status for feedback.

---

## Open questions

1. Cap visible rewards at 3 always, or scroll a short list?
2. Should earn rate update live when admin patches config mid-stream?
3. Identity prompt: custom UI vs rely on Twitch helper only?
4. Light mode: worth it, or Twitch panels are mostly dark?

---

## Risks & constraints

- Do not turn the panel into a mod dashboard or leaderboard browser.
- Hosted Test runs on `*.ext-twitch.tv` — API origin must stay allowlisted.
- Keep JS vanilla to match the repo (no React rewrite unless asked).

---

## Acceptance criteria

- [ ] Earn rate visible on load.
- [ ] Unaffordable rewards disabled with “need X more”.
- [ ] Confirm shows cost; cancel does not charge.
- [ ] Success feedback distinguishes Queued (and Playing when available).
- [ ] Usable on phone-sized panel width with large taps.
