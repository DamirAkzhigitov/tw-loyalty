import {
  createLoyaltyClient,
  escapeHtml,
  formatMs,
} from "../ext-shared/client.js";

const els = {
  chip: document.querySelector("#chip"),
  sheet: document.querySelector("#sheet"),
  sheetClose: document.querySelector("#sheet-close"),
  displayName: document.querySelector("#display-name"),
  points: document.querySelector("#points"),
  status: document.querySelector("#status"),
  earnRate: document.querySelector("#earn-rate"),
  rewards: document.querySelector("#rewards"),
  form: document.querySelector("#redeem-form"),
  redeemLabel: document.querySelector("#redeem-label"),
  redeemText: document.querySelector("#redeem-text"),
  redeemCancel: document.querySelector("#redeem-cancel"),
  redeemConfirm: document.querySelector("#redeem-confirm"),
  shareIdentity: document.querySelector("#share-identity"),
  pollSection: document.querySelector("#poll-section"),
  pollTitle: document.querySelector("#poll-title"),
  pollOptions: document.querySelector("#poll-options"),
  pollHint: document.querySelector("#poll-hint"),
};

let expanded = false;
let redeemFormOpen = false;

function setExpanded(next) {
  expanded = next;
  els.sheet.classList.toggle("hidden", !expanded);
  els.chip.setAttribute("aria-expanded", expanded ? "true" : "false");
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

const client = createLoyaltyClient({
  earnSurface: "overlay",
  isRedeemFormOpen: () => Boolean(els.form && !els.form.classList.contains("hidden")),
  onChange: render,
  onStatus: setStatus,
});

function render() {
  const state = client.getState();
  const viewer = state.viewer;
  if (viewer) {
    els.displayName.textContent = viewer.displayName;
    els.points.textContent = String(viewer.points);
  }
  if (els.earnRate) els.earnRate.textContent = state.earnRateLabel;
  if (els.shareIdentity) {
    els.shareIdentity.classList.toggle("hidden", !state.showShareIdentity);
  }
  renderRewards(state);
  renderPoll(state);
  renderRedeemForm(state);
}

function renderRewards(state) {
  els.rewards.innerHTML = "";
  const points = state.viewer?.points ?? 0;

  for (const reward of state.rewards) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "reward";
    const need = Math.max(0, reward.cost - points);
    const onCooldown = reward.id === "wheel" && state.wheelCooldownMs > 0;
    const unaffordable = points < reward.cost;
    btn.disabled = unaffordable || onCooldown;

    let extra = escapeHtml(reward.description || "");
    if (onCooldown) {
      extra = `Ready in ${formatMs(state.wheelCooldownMs)}`;
      btn.classList.add("need-more");
    } else if (unaffordable) {
      extra = `Need ${need} more`;
      btn.classList.add("need-more");
    }

    btn.innerHTML = `
      <div class="reward-title">
        <span>${escapeHtml(reward.label)}</span>
        <span class="reward-cost">${reward.cost} pts</span>
      </div>
      <div class="reward-desc">${extra}</div>
    `;
    btn.addEventListener("click", () => {
      setExpanded(true);
      client.openRedeem(reward);
    });
    els.rewards.appendChild(btn);
  }
}

function renderPoll(state) {
  const poll = state.poll;
  if (!poll) {
    els.pollSection.classList.add("hidden");
    return;
  }
  if (poll.status === "closed" && poll.endsAt && Date.now() >= poll.endsAt) {
    els.pollSection.classList.add("hidden");
    return;
  }

  els.pollSection.classList.remove("hidden");
  els.pollTitle.textContent =
    poll.status === "closed" ? `${poll.question} (final)` : poll.question;
  els.pollOptions.innerHTML = "";

  for (const option of poll.options || []) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "poll-option";
    if (state.myVoteOptionId === option.id) btn.classList.add("selected");
    btn.disabled = poll.status !== "open" || Boolean(state.myVoteOptionId);
    btn.textContent = `${option.label} · ${option.votes || 0}`;
    btn.addEventListener("click", () => void client.castVote(option.id));
    els.pollOptions.appendChild(btn);
  }

  if (poll.status === "closed") {
    els.pollHint.textContent = "Poll closed";
  } else if (state.myVoteOptionId) {
    els.pollHint.textContent = "Vote locked in";
  } else {
    const left = poll.endsAt ? Math.max(0, poll.endsAt - Date.now()) : 0;
    els.pollHint.textContent = left
      ? `Tap once to vote · ${formatMs(left)} left`
      : "Tap once to vote";
  }
}

function renderRedeemForm(state) {
  const reward = state.pendingReward;
  if (!reward?.needsText) {
    redeemFormOpen = false;
    els.form.classList.add("hidden");
    els.redeemText.value = "";
    els.redeemConfirm.textContent = "Confirm";
    els.redeemConfirm.disabled = false;
    return;
  }
  const justOpened = !redeemFormOpen;
  redeemFormOpen = true;
  setExpanded(true);
  els.form.classList.remove("hidden");
  els.redeemLabel.textContent = reward.id === "song" ? "Song / link" : "Message";
  if (reward.maxLength) els.redeemText.maxLength = reward.maxLength;
  els.redeemConfirm.textContent = `Confirm · ${reward.cost}`;
  if (justOpened) {
    els.redeemText.value = "";
    els.redeemText.focus();
  }
}

els.chip.addEventListener("click", () => {
  const next = !expanded;
  if (!next) client.closeRedeem();
  setExpanded(next);
});
els.sheetClose.addEventListener("click", () => {
  client.closeRedeem();
  setExpanded(false);
});
els.redeemCancel.addEventListener("click", () => client.closeRedeem());
els.shareIdentity?.addEventListener("click", () => client.requestIdentityShare());
els.form.addEventListener("submit", (event) => {
  event.preventDefault();
  els.redeemConfirm.disabled = true;
  void client.submitRedeem(els.redeemText.value.trim()).finally(() => {
    els.redeemConfirm.disabled = false;
  });
});

if (window === window.top) document.body.classList.add("dev-preview");

client.boot();
