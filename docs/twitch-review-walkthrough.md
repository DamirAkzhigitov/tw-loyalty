# Twitch Extension review copy

Paste these into Version Details. Replace `YOUR_CHANNEL` with your Twitch login.

## Name of Channel for Review

```text
https://www.twitch.tv/YOUR_CHANNEL
```

Use the channel where this version is **activated as Overlay 1**. The video overlay HUD only appears while the channel is **live**, so keep a stream running during review.

This version also includes a **Panel** view as an alternate slot. A channel can activate this Extension in only one desktop slot at a time (overlay **or** panel, plus mobile). Recommended: Overlay 1 + Mobile (`panel/index.html`).

Before you submit: Creator Dashboard → Extensions → deactivate any panel slot for this version, activate **Overlay 1**, and go live. Leave it activated until review finishes.

---

## Walkthrough Guide and Change Log

```text
WALKTHROUGH — Twitch Loyalty (Video Overlay HUD + Panel, v0.2)

What it is
A custom loyalty-points Extension for a small channel that is not using Bits or Channel Points. Viewers see a small “Loyalty” chip on the video player while the stream is live, earn points while the overlay is visible, and spend them on queued stream moments. A Panel view is included as an alternate slot (not active at the same time). This is not a Twitch Bits catalog and not Channel Points.

Type
Video overlay (recommended, Overlay 1) + Panel (alternate) + Mobile (panel/index.html). Not a video component. Reviewers need a live stream to see the overlay HUD.

Privacy / identity
Identity Link is enabled so we can show a Twitch display name instead of an opaque id. Privacy Policy: https://twitch-loyalty.damir-cy.workers.dev/privacy/
Please grant identity when prompted. If identity is declined, the HUD still works; the name may look like User-xxxx.

Backend
HTTPS API on Cloudflare Workers:
https://twitch-loyalty.damir-cy.workers.dev
Allowlisted for URL fetching. JWT from the Extension helper is sent as Authorization: Bearer.

How to test (reviewer) — overlay HUD
1. Open the live channel above. A “Loyalty” chip with a points balance should appear on the lower-left of the player (above the control bar). The rest of the player stays clickable.
2. Grant identity if asked.
3. Confirm the chip shows a points balance starting at 0. Leave the overlay visible. Points should increase about 1 per second.
4. Click the chip to expand the spend sheet. Status: “Watching · earning points”.
5. Spend:
   - On-screen shoutout — 40 points, no extra text. Should show “Queued: On-screen shoutout”.
   - Voice message (TTS) — 60 points. Enter a short message (max 120 chars), Confirm. Queued only.
   - Play music — 120 points. Enter a song name or link (max 160 chars), Confirm. Queued only.
6. If points are too low, wait with the overlay visible. Unaffordable spends return “Not enough points”.
7. Close collapses the sheet back to the chip. Hiding the Extension should stop earning.

How to test (reviewer) — panel (optional, if Overlay 1 is not used)
1. Activate this version in a panel slot instead of Overlay 1.
2. Scroll to channel panels and open “Twitch Loyalty”.
3. Same earn/spend loop as above.

What reviewers will NOT hear or see on the Twitch page
TTS is not read aloud yet. Songs do not autoplay. Shoutouts are queued for the streamer’s OBS overlay (Browser Source at /overlay/), which is not part of this Extension package and is not the video overlay HUD. “Queued: …” in the HUD/panel is the expected success state for this version.

Bits / monetization
None. No Bits in Extensions. No paid features.

CHANGE LOG — v0.2
- Video overlay HUD: collapsed Loyalty chip on the player, expand to earn + spend.
- Same catalog and API as the panel; shared client in ext-shared/.
- Panel kept as an alternate desktop slot + mobile view. One desktop slot at a time.
- Heartbeats pause when the overlay/tab is hidden.

CHANGE LOG — v0.1 (first review)
- Initial panel: earn 1 point/sec while the panel is open.
- Spend catalog: shoutout (40), TTS (60), song request (120); all queued.
- Identity Link + privacy policy for display names.
- Backend: Cloudflare Worker; Hosted Test assets on Twitch CDN.
```
