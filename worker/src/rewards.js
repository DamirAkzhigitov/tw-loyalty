/** Catalog of spendable actions. */
export const REWARDS = [
  {
    id: "shoutout",
    label: "On-screen shoutout",
    cost: 40,
    description: "Show your name on the overlay",
    needsText: false,
  },
  {
    id: "tts",
    label: "Voice message (TTS)",
    cost: 60,
    description: "Short text read aloud on stream",
    needsText: true,
    maxLength: 120,
  },
  {
    id: "song",
    label: "Play music",
    cost: 120,
    description: "Request a track (queued for streamer)",
    needsText: true,
    maxLength: 160,
  },
  {
    id: "wheel",
    label: "Chaos wheel",
    cost: 100,
    description: "Spin the challenge wheel on stream",
    needsText: false,
  },
];

/** Default weighted wheel segments (relative weights). */
export const DEFAULT_WHEEL_SEGMENTS = [
  { id: "easy", label: "Easy challenge", weight: 30, color: "#12b5a7" },
  { id: "hard", label: "Hard challenge", weight: 10, color: "#ff5d4a" },
  { id: "water", label: "Drink water", weight: 20, color: "#2f9ed8" },
  { id: "viewer", label: "Viewer picks", weight: 15, color: "#e8a317" },
  { id: "safe", label: "Nothing — safe!", weight: 15, color: "#8b9bb4" },
  { id: "chaos", label: "Super chaos", weight: 5, color: "#d61f3a" },
];

/**
 * @param {string} type
 */
export function getReward(type) {
  return REWARDS.find((r) => r.id === type) ?? null;
}

/**
 * @param {{ id: string, label: string, weight: number, color?: string }[]} segments
 * @param {number} [rand] 0..1
 */
export function pickWeightedSegment(segments, rand = Math.random()) {
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.weight || 0), 0);
  if (total <= 0) return segments[0] || null;
  let cursor = rand * total;
  for (let i = 0; i < segments.length; i++) {
    cursor -= Math.max(0, segments[i].weight || 0);
    if (cursor <= 0) return { segment: segments[i], index: i };
  }
  const last = segments.length - 1;
  return { segment: segments[last], index: last };
}
