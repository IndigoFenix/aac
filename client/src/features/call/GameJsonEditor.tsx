// client/src/features/call/GameJsonEditor.tsx
//
// A clinician-only testing affordance: while a social game is running on a call,
// edit the live game JSON (the CallGame, including its inline WorldSpec) and
// reload it for EVERY participant without leaving the call.
//
// Because a game is a property of the call, re-applying it via startGame()
// re-broadcasts `call:game` to all participants; each client's CallGameSurface
// re-initialises its world from the new spec (SocialWorldCanvas keys its render
// loop on the worldSpec identity), so the same players reload into the edited
// world. Built-in games carry only a worldSpecKey, so we resolve + inline the
// spec on open to make it editable; the edited spec is sent inline.
//
// Debug/testing tool → not translated (mirrors WorldDebugPanel, per CLAUDE.md).

import { useMemo, useState } from "react";
import { X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CallGame } from "@shared/realtime-events";
import { certifyWorldSpec } from "@shared/world-engine/index";
import { getWorldSpec } from "@shared/world-engine/specs/index";

interface Props {
  /** The game currently attached to the call. */
  game: CallGame;
  /** Re-apply the edited game to the call (broadcasts to every participant). */
  onReload: (game: CallGame) => void;
  /** Close the editor (does not change the running game). */
  onClose: () => void;
}

/** The game as editable JSON: a built-in game's worldSpecKey is resolved to an
 *  inline worldSpec so the whole world is visible and tweakable. */
function toEditable(game: CallGame): CallGame {
  if (game.worldSpec) return game;
  const resolved = game.worldSpecKey ? getWorldSpec(game.worldSpecKey) : null;
  return resolved ? { ...game, worldSpec: resolved } : game;
}

export function GameJsonEditor({ game, onReload, onClose }: Props) {
  const initial = useMemo(() => JSON.stringify(toEditable(game), null, 2), [game]);
  const [text, setText] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);

  const reload = () => {
    setStatus(null);
    let parsed: CallGame;
    try {
      parsed = JSON.parse(text);
    } catch (e: any) {
      setError(`JSON parse error: ${e?.message ?? String(e)}`);
      return;
    }
    if (!parsed || typeof parsed !== "object") {
      setError("The game JSON must be an object.");
      return;
    }
    if (typeof parsed.appId !== "string" || typeof parsed.engine !== "string") {
      setError('The game must have string "appId" and "engine" fields.');
      return;
    }
    // Validate the world before it reaches the engine on every client.
    if (parsed.worldSpec !== undefined) {
      const cert = certifyWorldSpec(parsed.worldSpec);
      if (!cert.ok) {
        setError(`Invalid worldSpec (${cert.stage}):\n${cert.errors.join("\n")}`);
        return;
      }
      parsed.worldSpec = cert.spec;
    } else if (!parsed.worldSpecKey) {
      setError('The game needs either a "worldSpec" or a "worldSpecKey".');
      return;
    }
    setError(null);
    onReload(parsed);
    setStatus("Reloaded for all players ✓");
  };

  const reset = () => {
    setText(initial);
    setError(null);
    setStatus(null);
  };

  return (
    <div className="absolute inset-y-0 end-0 z-[110] flex w-[28rem] max-w-[90vw] flex-col bg-gray-900/95 text-white shadow-2xl backdrop-blur">
      <div className="flex items-center justify-between border-b border-white/10 px-4 py-3">
        <div className="text-sm font-semibold">Edit game JSON</div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close editor"
          className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="px-4 pt-2 text-xs text-white/60">
        Edit the live game, then Reload to re-apply it to everyone in this call.
      </div>

      <textarea
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setStatus(null);
        }}
        spellCheck={false}
        className="m-4 flex-1 resize-none rounded-lg border border-white/10 bg-black/40 p-3 font-mono text-xs leading-relaxed text-emerald-100 outline-none focus:border-emerald-400/60"
      />

      {error && (
        <pre className="mx-4 mb-2 max-h-32 overflow-auto whitespace-pre-wrap rounded-lg bg-red-500/20 px-3 py-2 text-xs text-red-200">
          {error}
        </pre>
      )}
      {status && !error && (
        <div className="mx-4 mb-2 rounded-lg bg-emerald-500/20 px-3 py-2 text-xs text-emerald-200">
          {status}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 border-t border-white/10 px-4 py-3">
        <Button type="button" variant="ghost" size="sm" onClick={reset}>
          Reset
        </Button>
        <Button type="button" size="sm" onClick={reload}>
          Reload game
        </Button>
      </div>
    </div>
  );
}
