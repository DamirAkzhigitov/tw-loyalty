# Highlight my message

**Priority:** 8  
**Status:** Not built  
**Depends on:** Overlay alerts ([02](./02-overlay-alerts.md))  
**Why:** Cheaper than shoutout; good for lurkers who want to be seen

---

## Goal

Viewer spends a small amount → name + short text appears on the overlay for a few seconds (highlight), then fades. Lower drama than shoutout; higher frequency OK with cooldown.

---

## Proposed behavior

- Reward `highlight`: cost ~15–25, `needsText: true`, `maxLength: 80`.
- Auto-play or short queue; lower priority than shoutout/TTS/song.
- Overlay: compact banner (not full-screen).
- Cooldown per user e.g. 20–30s.

---

## Implementation plan

1. Add to `rewards.js`.
2. Reuse alert pipeline with `kind: "highlight"`.
3. Filter text (banned words, no links).
4. Panel: reuse redeem text form.
5. Optional: allow free highlights during poll downtime — product choice, default paid.

---

## Open questions

1. Auto-play always, or still go through queue?
2. Distinct visual from shoutout (size/color/duration) — how different?
3. Persist last N highlights in feed only, or also a “wall”?

---

## Risks & constraints

- Spam of cheap highlights can clutter OBS — cooldown + max queue depth.
- Keep panel confirm step so accidental spends are rare.

---

## Acceptance criteria

- [ ] Spend shows name + text on overlay for configured duration.
- [ ] Unaffordable / cooldown / filter failures are clear in panel.
- [ ] Does not permanently displace leaderboard layout.
