# Games

Standalone games for eyegaze (and other) input. Each game is a self-contained
Vite project that builds to `dist/public-games/<name>/` and is served at
`/games/<name>/`. The bare `/games/` path serves a launcher (`_launcher/`) that
lists all games and embeds the selected one in an iframe.

Games can run **standalone** (open the URL directly), **inside the launcher**
(at `/games/?game=<id>`), or **embedded** in the clinician/AAC client. Embedded
games communicate with their host through `postMessage` using the contract in
`shared/games-bridge.ts` — see `_template/src/main.ts` for a minimal example.

## Adding a new game

1. Copy `_template/` to `games/<your-game>/`.
2. Update the `GAME_NAME` constant in `vite.config.ts` and the `gameId` in `main.ts`.
3. Replace the body of `src/main.ts` with your game.
4. (Optional) `import { sendToParent, onPlatformMessage } from "@shared/games-bridge"`
   to hook into the platform. Always design so the game still works when no
   parent is present.
5. Add an entry to `_launcher/src/games.ts` so the new game shows up on the
   launcher's card grid.

## Dev

Run a single game's dev server:

```
npx vite --config games/<your-game>/vite.config.ts
```

## Build

Build all games (skips `_template`):

```
npm run build:games
```

Output lands in `dist/public-games/<name>/`. The platform's express static
handler should mount that directory at `/games/`.
