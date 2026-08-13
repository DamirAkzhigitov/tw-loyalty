# IRL / hardware integrations (later)

**Priority:** 14 (explicitly later)  
**Status:** Not planned for near-term build  
**Depends on:** Stable redeem queue + admin; external bridge  
**Why:** Fun “lights flash when I spend” — but extra infra

---

## Goal

Map selected redeems to real-world actuators (smart lights, fan, buzzer) via an existing bridge (e.g. Lumia Stream, Home Assistant, Streamer.bot → MQTT/Hue).

---

## Proposed approach (when ready)

1. Do **not** put IoT credentials in the Cloudflare Worker if avoidable.
2. Worker/DO emits a redeem event (already on WS overlay channel).
3. Local bridge listens (WS or webhook to streamer’s PC) and triggers device scenes.
4. Catalog entries like `lights` are optional rewards with cooldowns and hard caps.

```text
Panel redeem → DO queue → WS event → local bridge → Hue / relay / etc.
```

---

## Implementation sketch

- Config: `webhooks.onRedeem` URL (streamer local tunnel) **or** bridge consumes public WS.
- Payload: `{ type, displayName, cost, payload }`.
- Rate-limit hardware actions harder than on-screen alerts.
- Failures on hardware must not block overlay/TTS success.

---

## Open questions

1. Which bridge do we standardize on first?
2. Cloud webhook (needs public URL) vs local WS consumer?
3. Safety: physical devices (fans, FOG) need streamer confirmation every time?

---

## Risks & constraints

- Extra moving parts for a small channel — postpone until digital toys feel good.
- Safety and abuse: never expose raw device control to the public internet without auth.
- Out of scope to build a full smart-home product.

---

## Acceptance criteria (when revisited)

- [ ] At least one redeem type triggers a real device via a documented bridge.
- [ ] Hardware failure does not corrupt points/queue state.
- [ ] Cooldowns prevent continuous actuation.
- [ ] Credentials stay on the streamer’s machine or secret store — not in the client panel.
