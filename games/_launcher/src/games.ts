// Registry of installed games. Each entry maps a stable id (the folder under
// /games/) to the metadata the launcher needs to render its card.
//
// Add a new game here when you copy `_template` into `/games/<id>/`.

export interface GameEntry {
  id: string;
  name: string;
  description: string;
  emoji: string;
  /** Tailwind gradient classes — keeps the cards visually distinct without artwork. */
  gradient: string;
}

export const GAMES: GameEntry[] = [
  {
    id: "space-trader",
    name: "Space Trader",
    description: "Mine asteroids and trade your way up to collect the Star. A puzzle game made for eyegaze controls.",
    emoji: "🚀",
    gradient: "from-indigo-700 to-violet-900",
  },
  {
    id: "sandbox-game",
    name: "Sandbox Farm",
    description: "Plant seeds, harvest crops, and watch your idle farm grow over time. A relaxing game for eyegaze controls.",
    emoji: "🌱",
    gradient: "from-emerald-700 to-green-900",
  },
  {
    id: "bubbles-game",
    name: "Bubbles",
    description: "Tap or click to pop floating bubbles. A friendly reflex game for practicing hand-eye coordination.",
    emoji: "🫧",
    gradient: "from-sky-600 to-cyan-900",
  },
];
