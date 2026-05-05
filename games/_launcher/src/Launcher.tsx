import { useCallback, useEffect, useState } from "react";
import { GAMES, type GameEntry } from "./games";

function readGameFromUrl(): string | null {
  const params = new URLSearchParams(window.location.search);
  const id = params.get("game");
  if (!id) return null;
  return GAMES.some(g => g.id === id) ? id : null;
}

export default function Launcher() {
  const [activeGame, setActiveGame] = useState<string | null>(() => readGameFromUrl());

  // Keep state in sync with browser back/forward.
  useEffect(() => {
    const onPop = () => setActiveGame(readGameFromUrl());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const openGame = useCallback((id: string) => {
    const url = `${window.location.pathname}?game=${encodeURIComponent(id)}`;
    window.history.pushState({}, "", url);
    setActiveGame(id);
  }, []);

  const closeGame = useCallback(() => {
    window.history.pushState({}, "", window.location.pathname);
    setActiveGame(null);
  }, []);

  if (activeGame) {
    return <EmbeddedGame gameId={activeGame} onClose={closeGame} />;
  }

  return <GameList games={GAMES} onSelect={openGame} />;
}

function GameList({ games, onSelect }: { games: GameEntry[]; onSelect: (id: string) => void }) {
  return (
    <div className="min-h-screen w-full p-8">
      <header className="mx-auto max-w-5xl mb-10 text-center">
        <h1 className="text-4xl font-bold bg-gradient-to-r from-indigo-300 to-purple-300 bg-clip-text text-transparent">
          Aivota Games
        </h1>
        <p className="mt-2 text-slate-400">Pick a game to play.</p>
      </header>
      <ul className="mx-auto max-w-5xl grid gap-4 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
        {games.map(g => (
          <li key={g.id}>
            <button
              type="button"
              onClick={() => onSelect(g.id)}
              className={`group w-full text-left rounded-2xl p-5 bg-gradient-to-br ${g.gradient} shadow-lg hover:shadow-2xl transition-shadow active:scale-[0.99] focus:outline-none focus:ring-2 focus:ring-white/40`}
            >
              <div className="flex items-center gap-3">
                <span className="text-4xl" aria-hidden="true">{g.emoji}</span>
                <h2 className="text-xl font-semibold text-white">{g.name}</h2>
              </div>
              <p className="mt-3 text-sm text-white/80 leading-relaxed">{g.description}</p>
              <div className="mt-4 text-xs text-white/60 group-hover:text-white/80">Tap to play →</div>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function EmbeddedGame({ gameId, onClose }: { gameId: string; onClose: () => void }) {
  const game = GAMES.find(g => g.id === gameId);
  return (
    <div className="h-screen w-screen flex flex-col bg-black">
      <div className="flex items-center justify-between px-3 py-2 bg-slate-950 border-b border-slate-800 shrink-0">
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-100 text-sm font-medium"
          aria-label="Back to games"
        >
          ← Games
        </button>
        <div className="text-sm text-slate-300 truncate">
          {game ? `${game.emoji} ${game.name}` : gameId}
        </div>
        <div className="w-20" />
      </div>
      <iframe
        src={`/games/${encodeURIComponent(gameId)}/`}
        title={game?.name ?? gameId}
        className="flex-1 w-full border-0 block"
        sandbox="allow-scripts allow-same-origin allow-pointer-lock"
        allow="autoplay; fullscreen"
      />
    </div>
  );
}
