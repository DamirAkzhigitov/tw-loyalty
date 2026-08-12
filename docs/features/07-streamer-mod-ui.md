# Streamer / mod dashboard

**Priority:** 7  
**Status:** Not built (`public/config.html` is a stub)  
**Depends on:** Admin auth ([13](./13-technical-hardening.md)); queue playback ([01](./01-redeem-queue-playback.md))  
**Why:** Streamer needs live control without redeploying or curling APIs

---

## Goal

A simple browser UI (not the Twitch panel) to manage the queue, toggle rewards, pause earning, and tune costs/rate during a stream.

---

## Proposed surfaces

| Section | Actions |
|---------|---------|
| **Queue** | Play / Done / Reject; see TTS text & song links |
| **Rewards** | Enable/disable; edit costs |
| **Economy** | Rate, caps, pause earning |
| **Toys** | Start poll; edit wheel segments |
| **Danger** | Reset room (confirm) |

Hosted as Worker static asset: `/admin/` with `?channel=`.

---

## Implementation plan

1. Static page `public/admin/index.html` + `admin.js` + `admin.css`.
2. Auth: shared secret header first (`X-Admin-Secret`), later Twitch OAuth broadcaster/mod.
3. Poll `GET /api/admin/redeems` + WS overlay channel for live updates (or short polling).
4. Wire existing DO admin routes; add missing ones (reward toggles, poll create).
5. Cost edits: store overrides in DO `config.rewardOverrides[id] = { cost, enabled }` merged over `REWARDS`.
6. Keep UI utilitarian — this is a control surface, not a marketing page.

### Reward override merge

```js
function effectiveRewards(state) {
  return REWARDS.map((r) => ({
    ...r,
    ...state.config.rewardOverrides?.[r.id],
  })).filter((r) => r.enabled !== false);
}
```

Panel session already returns `rewards` — serve effective list there.

---

## Open questions

1. Secret-in-URL vs header-only? (Lean: header + localStorage on admin device; never put secret in OBS URLs.)
2. Mod access: same secret, or Twitch role check?
3. Mobile-friendly admin for phone-from-couch?
4. Separate “producer” machine URL vs same Worker?

---

## Risks & constraints

- `/api/admin/*` is currently open in practice — **do not** advertise the dashboard until locked.
- Admin must target the Extension channel id, not `local`, during real streams.
- Avoid putting admin links in the Extension package review surface.

---

## Acceptance criteria

- [ ] Streamer can process the redeem queue from a browser.
- [ ] Can pause earning and change rate/costs live.
- [ ] Can disable a reward mid-stream; panel stops offering it.
- [ ] Unauthorized requests fail when auth is enabled.
- [ ] Reset requires explicit confirm.
