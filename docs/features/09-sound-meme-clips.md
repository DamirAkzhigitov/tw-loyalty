# Sound / meme clips

**Priority:** 9  
**Status:** Not built  
**Depends on:** Redeem queue + overlay/audio playback path  
**Why:** Instant reaction (Sound Alerts niche) without cloning a huge library

---

## Goal

Viewer picks from a **small curated list** (5–10 clips) and spends points to play that sound on stream. Instant, funny, controllable.

---

## Proposed behavior

- Reward type `sound` with `payload.clipId` (not free text).
- Panel: grid/list of clip buttons (name + cost; costs may vary).
- On Play (or auto-play if enabled): overlay or local helper plays short audio (`<audio>` or helper).
- Global + per-clip cooldown; max duration e.g. 3–5s per clip.

---

## Implementation plan

### Config-owned catalog (not only `rewards.js`)

```js
clips: [
  { id: "bruh", label: "Bruh", cost: 30, url: "/media/bruh.mp3", cooldownMs: 15000 },
  // 5–10 total
]
```

- Store in DO config so streamer can enable/disable without redeploy.
- Host short MP3/OGG on Worker assets (`public/media/`) or R2 later.
- Redeem validates `clipId` against enabled clips.

### Playback

- Prefer OBS Browser Source `<audio>` with streamer-enabled sound.
- Document “Control audio” in OBS for the Browser Source.
- Fallback: Streamer.bot receives WS/webhook with `clipId`.

### Panel UX

- “Sounds” section or single “Play a sound” → secondary list (panel height is tight).
- Do not ship 50 clips.

---

## Open questions

1. One flat cost or per-clip pricing?
2. Auto-play sounds vs queue behind TTS?
3. Copyright: only streamer-owned / CC0 clips?
4. Volume normalization across clips?

---

## Risks & constraints

- Do not build a Sound Alerts / Blerp clone (`AGENTS.md` out of scope).
- Loud clips hurt stream — peak-normalize and hard cap duration.
- Asset size on Worker free tier — keep clips tiny or use external URLs carefully.

---

## Acceptance criteria

- [ ] 5–10 curated clips selectable in panel.
- [ ] Redeem plays the correct clip on stream path.
- [ ] Cooldowns prevent audio spam.
- [ ] Disabled clips disappear from panel without deploy.
