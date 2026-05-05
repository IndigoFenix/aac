// Minimal demo of the game ↔ platform bridge.
// Copy this folder, rename it, and replace the body with your actual game.

import { onPlatformMessage, sendToParent, type PlatformMessage } from "@shared/games-bridge";

const status = document.getElementById("status")!;
const log = document.getElementById("log")!;
const button = document.getElementById("action") as HTMLButtonElement;

function append(line: string) {
  const li = document.createElement("li");
  li.textContent = line;
  log.prepend(li);
}

const isEmbedded = window.parent !== window;
status.textContent = isEmbedded
  ? "Embedded in platform — listening for messages."
  : "No platform connected. Running standalone.";

onPlatformMessage((msg: PlatformMessage) => {
  append(`← platform: ${JSON.stringify(msg)}`);
  if (msg.type === "request_close") {
    sendToParent({ type: "session_end", reason: "quit" });
  }
});

button.addEventListener("click", () => {
  sendToParent({ type: "player_action", action: "demo_click" });
  append("→ platform: player_action demo_click");
});

sendToParent({ type: "ready", gameId: "_template", version: "0.0.0" });
