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
  hidden?: boolean;
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
    name: "Sandbox",
    description: "Push sand with your gaze to dig valleys and build hills, then watch springs, rivers and plants emerge from the shapes you make. A calm world-building toy for eyegaze, touch, or mouse.",
    emoji: "🏜️",
    gradient: "from-amber-500 to-orange-800",
  },
  {
    id: "bubbles-game",
    name: "Bubbles",
    description: "Tap or click to pop floating bubbles. A friendly reflex game for practicing hand-eye coordination.",
    emoji: "🫧",
    gradient: "from-sky-600 to-cyan-900",
  },
  {
    id: "musical-microbes",
    name: "Musical Microbes",
    description: "Grow a garden of tiny organisms and listen to the music they make together. A calm, no-wrong-notes sandbox for gaze, touch, or mouse.",
    emoji: "🎶",
    gradient: "from-fuchsia-700 to-indigo-900",
  },
  {
    id: "goal-tree-player",
    name: "Picnic Quest",
    description: "Explore, collect, answer and unlock your way to the goal. The first goal-tree quest — playable by gaze (dwell-to-walk or steering), touch, or mouse.",
    emoji: "🧺",
    gradient: "from-emerald-600 to-green-900",
  },
  {
    id: "dollhouse",
    name: "Dollhouse",
    description: "Watch over a living house as a friendly spirit. A small family goes about its day inside — talk to them and tell them what to do with sentence buttons, by gaze, touch, or mouse.",
    emoji: "🏠",
    gradient: "from-rose-500 to-purple-900",
  },
  {
    id: "seagull-dream",
    name: "Seagull Dream",
    description: "Fly a seagull over a tiny world. Look up to take off, look down to land. Hands-free 3D exploration.",
    emoji: "🕊️",
    hidden: true,
    gradient: "from-sky-500 to-indigo-900",
  },
  {
    id: "world-lab",
    name: "World Lab",
    description: "The game-maker's test bench: pick a test world, edit its world file, watch it boot. Dev tool — planets first.",
    emoji: "🌍",
    hidden: true,
    gradient: "from-teal-600 to-slate-900",
  },
  {
    id: "cloud-lab",
    name: "Cloud Lab",
    description: "Dev bench for clouds on the shared world-engine: orbit a real planet under the shared sky. Clouds themselves are WIP.",
    emoji: "☁️",
    hidden: true,
    gradient: "from-sky-700 to-slate-900",
  },
];
