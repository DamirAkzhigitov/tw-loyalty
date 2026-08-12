/** Catalog of spendable actions. */
export const REWARDS = [
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
    id: "shoutout",
    label: "On-screen shoutout",
    cost: 40,
    description: "Show your name on the overlay",
    needsText: false,
  },
];

/**
 * @param {string} type
 */
export function getReward(type) {
  return REWARDS.find((r) => r.id === type) ?? null;
}
