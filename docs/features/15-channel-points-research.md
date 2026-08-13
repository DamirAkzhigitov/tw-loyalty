# Channel Points instead of our currency?

**Priority:** Research only — do not implement yet  
**Status:** Findings as of 2026-08-13  
**Depends on:** Affiliate/Partner (monetized) channel; broadcaster OAuth; EventSub  
**Related:** Current custom points live in the Durable Object (`LoyaltyRoom`)

This is a policy + API research note. It is **not** a build plan.

---

## Direct answers

| Question | Answer |
|----------|--------|
| Do we have access to Channel Points? | **Only if the channel is monetized** (Affiliate or Partner who finished creator onboarding). Even then we do **not** get a wallet API. We can create/list **custom rewards** we own, and listen for **redemptions**. |
| Can we deduct Channel Points? | **Not arbitrarily.** There is no “subtract N points from user X” endpoint. Points leave a viewer’s balance only when **that viewer** redeems a reward in Twitch’s own Channel Points UI. We can **refund** a redemption we own (`CANCELED`). |
| Is replacing our currency with Channel Points allowed? | **Using Channel Points as native rewards is allowed.** Driving overlay/queue from those redemptions is the intended third-party path. **Spending Channel Points from inside the Extension panel is not supported** (Twitch declined that). **Converting Channel Points into our points (or the reverse) is not acceptable** under the Channel Points Acceptable Use Policy. **Keeping our own loyalty points is allowed.** |

**Recommendation for this repo:** keep our custom currency. Optionally, much later, *also* listen for native Channel Points redemptions so they can feed the same overlay queue. Do not try to make the panel a Channel Points checkout.

---

## 1. Access — what the APIs actually give us

### Eligibility (the channel, not our Worker)

Channel Points exist only on **monetized** channels:

- Twitch: “available to all monetized streamers.” An Affiliate invite alone is not enough; **creator onboarding must be complete**.
- Helix Channel Points endpoints return **403** if “the broadcaster is not a partner or affiliate.”

This project was started for a small channel that is **not** using Bits / Channel Points. If the channel is still unmonetized, **there is nothing to integrate**.

Official: [Channel Points Guide](https://help.twitch.tv/s/article/channel-points-guide), [Channel Points FAQ](https://help.twitch.tv/s/article/channel-points-faq).

### What Helix exposes

All of these live under `/helix/channel_points/custom_rewards`. There is **no** endpoint for a viewer’s balance.

| Endpoint | What it does | Token / scope |
|----------|----------------|---------------|
| Create Custom Rewards | Create a reward on the channel | User token, `channel:manage:redemptions` |
| Get Custom Reward | List rewards (optionally only ones this app can manage) | `channel:read:redemptions` or manage |
| Update / Delete Custom Reward | Edit or remove **only rewards this `client_id` created** | manage |
| Get Custom Reward Redemption | List redemptions for **those same rewards** | read or manage |
| Update Redemption Status | `FULFILLED` or `CANCELED` (refund) | manage |

Docs: [Helix reference — Channel Points](https://dev.twitch.tv/docs/api/reference/#create-custom-rewards).

Hard limits that matter for us:

- **50 custom rewards per channel** (enabled + disabled).
- We can only fulfill/refund redemptions for rewards **created by our app’s `client_id`**. Dashboard-created rewards (or StreamElements / Streamer.bot with a different client id) return **403**.
- `broadcaster_id` on manage calls must match the user in the OAuth token (the streamer must authorize **our** Twitch app).
- Cost minimum is **1** Channel Point; we cannot invent a free “debit.”

### What Helix does **not** expose

Twitch staff and docs are consistent:

- No get-balance API (not even with the viewer’s own token). Forum: [Get Channel Points](https://discuss.dev.twitch.com/t/get-channel-points/56265) — “No this is not supported.”
- Streamers cannot see a viewer’s balance, reset points, grant bonus points, or import another program’s balances ([FAQ](https://help.twitch.tv/s/article/channel-points-faq)).
- Viewer balances are **private to the viewer** (shown in chat).

So the panel **cannot** show “you have 1,240 Channel Points” from our Worker. The only spend UI that knows the balance is Twitch chat.

### EventSub (the realistic integration)

If we wanted overlay moments to fire when someone spends Channel Points:

1. Streamer OAuth-grants our app `channel:read:redemptions` (listen) or `channel:manage:redemptions` (create rewards + refund).
2. Worker subscribes to `channel.channel_points_custom_reward_redemption.add` (and optionally `.update`).
3. Twitch POSTs to our Worker when a viewer redeems.

[EventSub: redemption add](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchannel_points_custom_reward_redemptionadd). Payload includes `user_id`, `user_name`, `user_input`, `reward.title` / `cost`, `status`.

On Cloudflare Workers, **HTTPS webhooks** fit; a long-lived EventSub WebSocket does not. That is new infra (callback URL, secret, subscription lifecycle), not a small patch on `POST /api/viewer/redeem`.

### Extension JWT is not enough

Today we authenticate viewers with the **Extension JWT** (`EXT_SECRET`) plus optional Helix user lookup for display names. That token does **not** include `channel:manage:redemptions`. Channel Points management is a **broadcaster** OAuth grant to a Helix app, stored and refreshed by us. The current Worker has none of that.

---

## 2. Deduct — how points actually leave a wallet

Twitch deducts Channel Points **only** as part of a viewer-initiated redemption in the **native Channel Points UI** (chat reward balloon). Flow:

```text
Viewer clicks a reward in Twitch chat
  → Twitch checks balance, deducts cost, creates UNFULFILLED redemption
  → EventSub notifies our Worker (if subscribed)
  → We queue overlay / TTS / song
  → We (or a mod) mark FULFILLED, or CANCELED (refund)
```

**Refund (the only “undeduct” we control):**

`PATCH /helix/channel_points/custom_rewards/redemptions` with `{ "status": "CANCELED" }`  
— only if status is still `UNFULFILLED`, and only for rewards **our `client_id` created**.

That maps cleanly to “reject song/TTS → refund,” which we already want for our own currency.

What we **cannot** do:

- Deduct from the panel spend buttons (`POST /api/viewer/redeem`).
- Charge an arbitrary amount at runtime (cost is fixed on the reward; we can PATCH the reward’s cost, not a one-off debit).
- Pull points because the heartbeat is open.
- Move Channel Points between viewers or channels.

Twitch declined “Channel Point transaction in extension” (UserVoice, closed 2021) with: redemptions stay in the chat UI for a consistent viewer experience. Developer forum confirmation: [Use Channel Points in Twitch Extensions?](https://discuss.dev.twitch.com/t/use-channel-points-in-twitch-extensions/51777).

**If we “switched” to Channel Points, the Extension panel would stop being the checkout.** Viewers would spend in chat; the panel could at most say “redeem X in Channel Points.” That fights the product rule: keep the panel as the obvious spend UI.

---

## 3. Agreements / policies — is it acceptable?

Not legal advice. Sources below are the public policies that govern this.

### Our custom points (status quo) — allowed

[Extensions Guidelines & Policies §5.2](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/):

> Extensions may not allow items to be exchanged for money or other commerce instruments. **Items may be exchanged for loyalty-based points or Bits** (in compliance with the Bits Acceptable Use Policy and the Bits-in-Extensions Policies).

Earned-by-watching, spent on stream moments, no cash-out, no real-world prizes: that is the intended “loyalty-based points” case. Twitch FAQ also: **“Can I continue to use my existing points program from a 3rd party developer? Yes.”**

Constraints that already apply to *any* points in an Extension (ours or Bits):

- No exchanging items for money.
- User-generated TTS/song text is “user content” (§7): identity, review/reject, show username.
- Bits-in-Extensions has extra bans (jukebox, free-form Bits catalog, gambling). Those apply to **Bits**, not to our free loyalty points — but if we later sold the same catalog for Bits, song-request audio would conflict with §6.2.2.

### Using Channel Points as the spend currency — allowed, with a specific shape

[Channel Points Acceptable Use Policy](https://legal.twitch.com/en/legal/channel-points-acceptable-use-policy) (developers are also under the [Developer Services Agreement](https://legal.twitch.tv/legal/developer-agreement/)):

- Points are **not money**, have **no monetary value**, cannot be purchased.
- Redemptions may be offered by the creator **or a third-party developer / Extension**.
- Creators must link any extra third-party terms.
- Allowed examples include “Participating in Experiences” — overlay shoutout / TTS / wheel fits if it stays on-Twitch entertainment.

Forbidden (relevant bits):

- Gambling.
- Redemptions for tobacco, alcohol, pharma, **imitation currency**, etc.
- **Sell, trade, barter, or transfer Points … in exchange for Bits or in exchange for real or virtual currencies** inside or outside Twitch.
- Real-world items of value (the AUP plus forum interpretation: do not make Channel Points look like they have cash value).

So: **custom Channel Points rewards that trigger our overlay = acceptable.**  
**Panel button that spends Channel Points = not an available API**, and Twitch does not want that UX.

### Converting between Channel Points and our points — not acceptable

Two directions both fail the AUP:

| Idea | Why it fails |
|------|----------------|
| Redeem Channel Points → credit our Durable Object balance | Trading Points for another **virtual currency**. Explicitly banned. Forum threads treat “CP → community tokens” as the same risk. |
| Spend our points to grant Channel Points | No grant API anyway; would also be transferring/creating Points outside Twitch’s earning rules. |
| Import existing loyalty balances into Channel Points | FAQ: **“Will I be able to transfer points from my existing program? Not at this time.”** |

Do not run a dual-wallet exchange. Dual **programs** (Twitch Channel Points in chat + our panel currency, separate balances, no conversion) is what Twitch already says is fine.

### Bits vs Channel Points vs us

| Currency | Who can use it | Spend UI | Our access |
|----------|----------------|----------|------------|
| **Our points** | Any channel | Extension panel | Full (we own the ledger) |
| **Channel Points** | Monetized only | Twitch chat rewards | Rewards + redemptions we created; no balance |
| **Bits** | Paid cheer; Bits-in-Extensions needs review | Extension *or* cheer | Separate product; out of scope unless we want directory monetization |

---

## 4. What a Channel Points-based product would look like here

If we ignored eligibility and still replaced our currency:

| Today | With Channel Points |
|-------|---------------------|
| Heartbeat earns 1 pt/s in the DO | Twitch owns earning (watch, follow, raid, streaks). Panel heartbeat becomes **presence-only**. |
| Panel spend buttons deduct DO balance | Buttons cannot deduct. Catalog lives in **chat rewards**. |
| Overlay leaderboard of *our* points | No Channel Points leaderboard API. Overlay “top spenders” of CP is not available. |
| Reject → we refund DO points | Reject → `CANCELED` on **our** custom rewards. |
| Works in Hosted Test / `local` DevViewer | Needs real monetized channel + streamer OAuth. |

New moving parts we do not have: Twitch Application (Helix client id/secret, not just `EXT_SECRET`), broadcaster OAuth + refresh tokens, EventSub webhook verification, creating/pausing rewards from config, mapping `reward_id` → shoutout/TTS/song.

That is a different architecture, not a swap in `rewards.js`.

---

## 5. Options (if we revisit later)

**A. Keep custom points only (default)**  
Fits non-Affiliate channels, in-panel spend, leaderboard, and current review copy. Policy-ok.

**B. Hybrid later (optional)**  
Keep the panel currency. *Additionally* create 2–3 Channel Points rewards (if/when the channel is monetized) and EventSub them into the same redeem queue. Two spend surfaces, **no conversion**. Useful when viewers already sit in chat and never open the panel.

**C. Replace our currency with Channel Points**  
Drop panel earning/spending. Panel becomes a status widget (“go redeem in chat”). Lose leaderboard-of-balances. Blocked until Affiliate. Conflicts with “panel is for clicking.”

**D. Exchange / shared wallet**  
Do not do this. Policy risk and no APIs.

---

## Open questions (only if we pick B or C)

1. Is this channel actually monetized (Affiliate/Partner onboarding complete)?
2. Are we willing to add a Twitch Helix app + streamer OAuth besides the Extension?
3. For hybrid: who owns the three rewards if StreamElements already created similar ones?
4. Overlay leaderboard: keep it as *our* points only, or drop it?

---

## Sources

- [Helix Channel Points endpoints](https://dev.twitch.tv/docs/api/reference/#create-custom-rewards)
- [Scopes: `channel:read:redemptions` / `channel:manage:redemptions`](https://dev.twitch.tv/docs/authentication/scopes/)
- [EventSub `channel.channel_points_custom_reward_redemption.add`](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchannel_points_custom_reward_redemptionadd)
- [Channel Points Guide](https://help.twitch.tv/s/article/channel-points-guide) / [FAQ](https://help.twitch.tv/s/article/channel-points-faq)
- [Channel Points Acceptable Use Policy](https://legal.twitch.com/en/legal/channel-points-acceptable-use-policy)
- [Extensions Guidelines §5.2 (loyalty points / Bits)](https://dev.twitch.tv/docs/extensions/guidelines-and-policies/)
- [Developer forum: Channel Points are not an Extension transaction](https://discuss.dev.twitch.com/t/use-channel-points-in-twitch-extensions/51777)
- [Developer forum: no balance API](https://discuss.dev.twitch.com/t/get-channel-points/56265)
