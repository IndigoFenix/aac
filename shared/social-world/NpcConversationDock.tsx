// shared/social-world/NpcConversationDock.tsx
//
// The in-world conversation dock: when the player is standing in an NPC's
// conversation circle, this shows that NPC's procedural face, its latest line,
// and a text box to talk to it. Self-styled with inline styles (like
// CallGameSurface) so it drops into either client's game surface unchanged.
//
// One NPC at a time — the world host reports the nearest in-range NPC, the
// conversation hook makes it active, and this renders it. Walk to another NPC and
// the dock switches.

import { useState, type FormEvent } from "react";
import { ProceduralFace } from "../social-bot/ProceduralFace";
import type { NpcConvState } from "./useNpcConversations.js";

const LABELS: Record<string, string> = {
  "socialWorld.npcSay": "Say something…",
  "socialWorld.npcSend": "Send",
  "socialWorld.npcThinking": "…",
  "socialWorld.npcConnecting": "Connecting…",
  "socialWorld.npcError": "Couldn't reach this character.",
};

interface Props {
  /** The active NPC's conversation state, or null to render nothing. */
  state: NpcConvState | null;
  onSend: (text: string) => void;
  t?: (key: string) => string;
}

export default function NpcConversationDock({ state, onSend, t }: Props) {
  const [draft, setDraft] = useState("");
  const tr = (key: string) => {
    const translated = t?.(key);
    return translated && translated !== key ? translated : LABELS[key] ?? key;
  };

  if (!state) return null;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text || state.phase !== "ready") return;
    onSend(text);
    setDraft("");
  };

  const status =
    state.phase === "error"
      ? tr("socialWorld.npcError")
      : state.phase === "connecting"
        ? tr("socialWorld.npcConnecting")
        : state.awaitingReply
          ? tr("socialWorld.npcThinking")
          : "";

  return (
    <div
      style={{
        position: "absolute",
        left: "50%",
        bottom: 16,
        transform: "translateX(-50%)",
        width: "min(520px, calc(100% - 24px))",
        display: "flex",
        alignItems: "flex-end",
        gap: 12,
        padding: 12,
        borderRadius: 16,
        background: "rgba(15,23,42,0.82)",
        boxShadow: "0 8px 30px rgba(0,0,0,0.45)",
        backdropFilter: "blur(6px)",
        pointerEvents: "auto",
      }}
    >
      {/* Face badge */}
      <div style={{ width: 72, height: 72, flex: "0 0 auto", borderRadius: 12, overflow: "hidden", background: "rgba(255,255,255,0.06)" }}>
        {state.appearance && (
          <ProceduralFace
            target={state.target}
            appearance={state.appearance}
            expressiveness={state.expressiveness}
            legibility={state.legibility}
            speakingLevel={state.speakingLevel}
            style={{ width: 72, height: 72 }}
          />
        )}
      </div>

      {/* Name + caption + input */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
          <span style={{ color: "#e2e8f0", fontWeight: 700 }}>{state.name || "…"}</span>
          <span style={{ color: "#94a3b8", fontSize: 12, textTransform: "lowercase" }}>{state.mode.toLowerCase()}</span>
        </div>
        {/* Rolling transcript — the shared group conversation (player + NPC lines). */}
        <div
          style={{
            fontSize: 14,
            maxHeight: 110,
            overflowY: "auto",
            display: "flex",
            flexDirection: "column",
            gap: 2,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          {state.transcript.map((line, i) => (
            <div key={i} style={{ color: line.isNpc ? "#e2e8f0" : "#93c5fd" }}>
              <span style={{ fontWeight: 700 }}>{line.who}: </span>
              <span>{line.text}</span>
            </div>
          ))}
          {status && (
            <div style={{ color: state.phase === "error" ? "#fca5a5" : "#94a3b8", fontStyle: "italic" }}>{status}</div>
          )}
        </div>
        <form onSubmit={submit} style={{ display: "flex", gap: 8 }}>
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={tr("socialWorld.npcSay")}
            aria-label={tr("socialWorld.npcSay")}
            disabled={state.phase !== "ready"}
            style={{
              flex: 1,
              minWidth: 0,
              padding: "8px 12px",
              borderRadius: 10,
              border: "1px solid rgba(148,163,184,0.4)",
              background: "rgba(2,6,23,0.6)",
              color: "#e2e8f0",
              outline: "none",
            }}
          />
          <button
            type="submit"
            disabled={state.phase !== "ready" || !draft.trim()}
            style={{
              padding: "8px 16px",
              borderRadius: 10,
              border: "none",
              background: state.phase === "ready" && draft.trim() ? "rgba(16,185,129,0.95)" : "rgba(71,85,105,0.7)",
              color: "white",
              fontWeight: 700,
              cursor: state.phase === "ready" && draft.trim() ? "pointer" : "default",
            }}
          >
            {tr("socialWorld.npcSend")}
          </button>
        </form>
      </div>
    </div>
  );
}
