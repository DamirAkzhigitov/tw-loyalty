# Twitch Extension review copy

Paste these into Version Details. Replace `YOUR_CHANNEL` with your Twitch login.

## Name of Channel for Review

```text
https://www.twitch.tv/YOUR_CHANNEL
```

Use the channel where this version is **activated** as a **Panel**. This Extension is a Panel only (not a Component or Video Overlay), so the channel does **not** need to stay live during review.

Before you submit: Creator Dashboard → Extensions → add this version to a panel slot. Leave it activated until review finishes.

---

## Walkthrough Guide and Change Log

```text
WALKTHROUGH — Twitch Loyalty (Panel, v0.1)

What it is
A custom loyalty-points panel for a small channel that is not using Bits or Channel Points. Viewers keep the panel open while watching, earn points, and spend them on queued stream moments. This is not a Twitch Bits catalog and not Channel Points.

Type
Panel only. No video overlay / component. Reviewers do not need a live stream.

Privacy / identity
Identity Link is enabled so we can show a Twitch display name instead of an opaque id. Privacy Policy: https://twitch-loyalty.damir-cy.workers.dev/privacy/
Please grant identity when prompted. If identity is declined, the panel still works; the name may look like User-xxxx.

Backend
HTTPS API on Cloudflare Workers:
https://twitch-loyalty.damir-cy.workers.dev
Allowlisted for URL fetching. JWT from the Extension helper is sent as Authorization: Bearer.

How to test (reviewer)
1. Open the channel above. Scroll to channel panels and open “Twitch Loyalty” (or the submitted Extension name).
2. Grant identity if asked.
3. Confirm the panel shows a display name (or User-xxxx) and a Points balance starting at 0.
4. Leave the panel visible. Points should increase about 1 per second (status: “Watching · earning points”).
5. Spend:
   - On-screen shoutout — 40 points, no extra text. Should show “Queued: On-screen shoutout”.
   - Voice message (TTS) — 60 points. Enter a short message (max 120 chars), Confirm. Queued only.
   - Play music — 120 points. Enter a song name or link (max 160 chars), Confirm. Queued only.
6. If points are too low, wait with the panel open. Unaffordable spends return “Not enough points”.
7. Cancel on the text form dismisses without charging.

What reviewers will NOT hear or see on the Twitch page
TTS is not read aloud yet. Songs do not autoplay. Shoutouts are queued for the streamer’s OBS overlay (Browser Source), which is not part of this Extension package. The panel showing “Queued: …” is the expected success state for this version.

Bits / monetization
None. No Bits in Extensions. No paid features.

CHANGE LOG — v0.1 (first review)
- Initial panel: earn 1 point/sec while the panel is open.
- Spend catalog: shoutout (40), TTS (60), song request (120); all queued.
- Identity Link + privacy policy for display names.
- Backend: Cloudflare Worker; Hosted Test assets on Twitch CDN.
```
