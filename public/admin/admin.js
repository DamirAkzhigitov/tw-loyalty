const params = new URLSearchParams(location.search);
const API_BASE =
  params.get("api") || `${location.origin.replace(/\/$/, "")}/api`;

const els = {
  channel: document.querySelector("#channel"),
  status: document.querySelector("#status"),
  queue: document.querySelector("#queue"),
  playingLine: document.querySelector("#playing-line"),
  pollForm: document.querySelector("#poll-form"),
  pollQuestion: document.querySelector("#poll-question"),
  pollOptions: document.querySelector("#poll-options"),
  pollDuration: document.querySelector("#poll-duration"),
  pollLive: document.querySelector("#poll-live"),
  pollClose: document.querySelector("#poll-close"),
};

const savedChannel =
  params.get("channel") || localStorage.getItem("loyaltyAdminChannel") || "local";
els.channel.value = savedChannel;

function channelId() {
  return els.channel.value.trim() || "local";
}

function setStatus(text, kind = "") {
  els.status.textContent = text;
  els.status.className = `status ${kind}`.trim();
}

function apiUrl(path) {
  const url = new URL(`${API_BASE}${path}`, location.href);
  url.searchParams.set("channel", channelId());
  return url.toString();
}

async function api(path, options = {}) {
  const res = await fetch(apiUrl(path), {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `http_${res.status}`);
    err.data = data;
    throw err;
  }
  return data;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderQueue(data) {
  const playing = data.nowPlaying;
  els.playingLine.textContent = playing
    ? `Playing: ${playing.type} · ${playing.displayName}`
    : "Nothing playing";

  const items = (data.redeems || []).filter(
    (e) => e.status === "queued" || e.status === "playing",
  );

  els.queue.innerHTML = "";
  if (!items.length) {
    els.queue.innerHTML = `<li class="empty">Queue is empty</li>`;
    return;
  }

  for (const event of items) {
    const li = document.createElement("li");
    const text = event.payload?.text
      ? `<div class="payload">${escapeHtml(event.payload.text)}</div>`
      : event.result?.label
        ? `<div class="payload">Result: ${escapeHtml(event.result.label)}</div>`
        : "";
    const canPlay = event.status === "queued" && !playing;
    li.innerHTML = `
      <div class="meta">
        <span>${escapeHtml(event.displayName)} · ${escapeHtml(event.type)}</span>
        <span>${event.cost} pts · ${escapeHtml(event.status)}</span>
      </div>
      ${text}
      <div class="actions"></div>
    `;
    const actions = li.querySelector(".actions");

    if (event.status === "queued") {
      const play = document.createElement("button");
      play.textContent = "Play";
      play.disabled = !canPlay;
      play.addEventListener("click", () => void act(event.id, "play"));
      actions.appendChild(play);
    }

    if (event.status === "playing") {
      const done = document.createElement("button");
      done.className = "secondary";
      done.textContent = "Done";
      done.addEventListener("click", () => void act(event.id, "complete"));
      actions.appendChild(done);
    }

    const reject = document.createElement("button");
    reject.className = "ghost";
    reject.textContent = event.status === "playing" ? "Skip / refund" : "Reject";
    reject.addEventListener("click", () => void act(event.id, "reject"));
    actions.appendChild(reject);

    els.queue.appendChild(li);
  }
}

function renderPoll(poll) {
  if (!poll) {
    els.pollLive.classList.add("hidden");
    els.pollClose.classList.add("hidden");
    return;
  }

  els.pollLive.classList.remove("hidden");
  const total = poll.totalVotes || 1;
  els.pollLive.innerHTML = `
    <strong>${escapeHtml(poll.question)}</strong>
    <span class="sub">${escapeHtml(poll.status)} · ${poll.totalVotes || 0} votes</span>
    ${poll.options
      .map((o) => {
        const pct = Math.round(((o.votes || 0) / total) * 100);
        return `<div class="bar-row">
          <span>${escapeHtml(o.label)} · ${o.votes} (${pct}%)</span>
          <div class="bar"><span style="width:${pct}%"></span></div>
        </div>`;
      })
      .join("")}
  `;

  if (poll.status === "open") {
    els.pollClose.classList.remove("hidden");
    els.pollClose.onclick = () => void closePoll(poll.id);
  } else {
    els.pollClose.classList.add("hidden");
  }
}

async function act(id, action) {
  try {
    await api(`/admin/redeems/${id}/${action}`, { method: "POST", body: "{}" });
    setStatus(`${action} ok`, "ok");
    await refresh();
  } catch (err) {
    setStatus(err.message, "err");
  }
}

async function closePoll(id) {
  try {
    await api(`/admin/polls/${id}/close`, { method: "POST", body: "{}" });
    setStatus("Poll closed", "ok");
    await refresh();
  } catch (err) {
    setStatus(err.message, "err");
  }
}

async function refresh() {
  localStorage.setItem("loyaltyAdminChannel", channelId());
  try {
    const data = await api("/admin/redeems");
    renderQueue(data);
    renderPoll(data.activePoll);
    setStatus(`Channel ${channelId()} · refreshed`, "ok");
  } catch (err) {
    setStatus(err.message, "err");
  }
}

els.channel.addEventListener("change", () => void refresh());
els.pollForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const options = els.pollOptions.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((label, i) => ({ id: `opt${i + 1}`, label }));
  const durationSec = Number(els.pollDuration.value) || 60;
  void api("/admin/polls", {
    method: "POST",
    body: JSON.stringify({
      question: els.pollQuestion.value.trim(),
      options,
      durationMs: durationSec * 1000,
    }),
  })
    .then(() => {
      setStatus("Poll opened", "ok");
      return refresh();
    })
    .catch((err) => setStatus(err.message, "err"));
});

void refresh();
setInterval(() => void refresh(), 2000);
