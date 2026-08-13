# Overlay theme / color change

**Priority:** 10  
**Status:** Not built  
**Depends on:** Overlay CSS variables; redeem + timed clear  
**Why:** Visible “I was here” without needing audio

---

## Goal

Viewer spends points to time-box a cosmetic change on the OBS overlay (accent color, theme preset). Reverts automatically so the layout is not wrecked permanently.

---

## Proposed behavior

- Reward `theme`: cost ~40–80; payload `themeId` from a small preset list (not free CSS).
- On redeem/play: DO sets `activeTheme: { id, endsAt, by }`; broadcast.
- Overlay applies preset via `data-theme` or CSS variables.
- Alarm/timer clears theme; optional queue if another theme is waiting.

### Preset examples

| id | Effect |
|----|--------|
| `gold` | Gold accents / borders |
| `ice` | Cool blue accents |
| `ember` | Warm red accents |
| `mono` | High-contrast monochrome |

Avoid free-form color pickers in MVP (ugly + hard to moderate).

---

## Implementation plan

1. Define presets in overlay CSS (`[data-theme="gold"] { --accent: ... }`).
2. DO config lists enabled presets; redeem validates id.
3. `setAlarm` / complete timer to clear `activeTheme`.
4. Panel: small preset picker (2–4 choices) after tapping Theme.
5. Show requester name subtly (“Theme by Alice”) optional.

---

## Open questions

1. Stack with alerts or only ambient chrome?
2. Duration default — 60s, 120s, 300s?
3. Can themes be purchased while one is active (queue vs extend vs reject)?
4. Brand safety: block presets that fight facecam lighting?

---

## Risks & constraints

- Time-box is mandatory — permanent viewer CSS is a support nightmare.
- Keep presets subtle; do not hide leaderboard text contrast.

---

## Acceptance criteria

- [ ] Spend applies a named preset visible on OBS.
- [ ] Theme auto-reverts after duration.
- [ ] Invalid / disabled presets rejected.
- [ ] Overlay remains readable in all presets.
