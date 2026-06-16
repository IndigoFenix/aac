// client-aac/src/contexts/SocialBotContext.tsx
//
// Bridges the SERVER-OWNED social-training session into the header UI.
//
// In the three-agent system the peer persona REPLACES the Speaker agent
// server-side (AgentCoordinator.startSocialPeerSession): its speech,
// streaming text, TTS audio, and the response board all flow through the
// normal AAC channels. The old separate `/ws/social-bot` connection,
// mute forcing, utterance forwarding, and client-composed debrief are
// gone — the server does all of that now.
//
// What this context still owns:
//   - Activation tracking (activeApp === "social_trainer")
//   - The peer's procedural face data (from the `social_session` message,
//     surfaced as `socialSession` on the dual-agent context)
//   - A face target derived from the avatar emote + a mouth-flap level
//     derived from audio playback
//   - Asking the server to start client-initiated launches
//   - Ending the session on cave click (dismissApp → app_dismissed)

import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { useDualAgentContext } from "./DualAgentContext";
import { NEUTRAL_FACE, type FaceTarget, type FaceAppearance } from "@shared/social-bot/ProceduralFace";

interface SocialBotContextValue {
  /** True while a social training session is active. */
  active: boolean;
  /** True once the server has confirmed the session (face data arrived). */
  connected: boolean;
  /** Where the face should be heading — client lerps from current. */
  faceTarget: FaceTarget;
  /** Procedural appearance fixed for this session. Null until the server confirms. */
  appearance: FaceAppearance | null;
  expressiveness: number;
  legibility: number;
  /** Instantaneous mouth amplitude (0..1) for lip-sync on the face. */
  speakingLevel: number;
  /** Latest peer line — replaces the AI's text in the header. */
  botText: string;
  voiceName: string | null;
  characterName: string | null;
  /** Cancel the active session (cave click). No-op when not active. */
  cancel: () => void;
}

const SocialBotContext = createContext<SocialBotContextValue | null>(null);

/** Avatar emote → peer face target. The peer's only mood channel in the
 *  integrated mode is the Speaker `emote` tool (happy/sad/neutral); map
 *  each onto the procedural face's mood axes. */
const EMOTE_FACE: Record<"happy" | "sad" | "neutral", FaceTarget> = {
  happy: { v: 0.7, a: 0.35, r: 0.6, smirk: 0.15, gx: 0, gy: 0 },
  sad: { v: -0.5, a: -0.2, r: 0.3, smirk: 0, gx: 0, gy: -0.2 },
  neutral: { v: 0.15, a: 0, r: 0.4, smirk: 0, gx: 0, gy: 0 },
};

/** Mouth-flap update cadence. Coarser than rAF on purpose — each tick
 *  re-renders the provider subtree; the face's internal lerp smooths it. */
const SPEAKING_TICK_MS = 100;

interface ProviderProps {
  children: ReactNode;
}

export function SocialBotProvider({ children }: ProviderProps) {
  const {
    activeApp,
    dismissApp,
    launchApp,
    socialSession,
    socialPeerState,
    notifySocialTrainerStarted,
    isPlaying,
    audioPlayingTag,
    emote,
  } = useDualAgentContext();

  const active = activeApp?.appId === "social_trainer";
  const connected = !!socialSession;

  // Trace activation transitions so we can see whether the launch path
  // (open_app / social_trainer_started) actually fired.
  useEffect(() => {
    console.log("[SocialBot] activation change", {
      active,
      connected,
      characterName: socialSession?.characterName ?? null,
    });
  }, [active, connected, socialSession?.characterName]);

  // Client-initiated launch: when the app activates locally and the
  // server hasn't confirmed a session yet, ask it to start one. For
  // AI-initiated launches the server already started the session before
  // sending app_open — its start guard drops the redundant request.
  const requestedRef = useRef(false);
  useEffect(() => {
    if (!active) {
      requestedRef.current = false;
      return;
    }
    if (requestedRef.current || socialSession) return;
    requestedRef.current = true;
    notifySocialTrainerStarted();
  }, [active, socialSession, notifySocialTrainerStarted]);

  // Debug helpers. Expose manual launch/dismiss on `window` so a session
  // can be tested without depending on the AAC AI's discretion.
  //
  // In the browser console:
  //   window.__startSocialBot()    // flip activeApp to social_trainer
  //   window.__stopSocialBot()     // dismiss the active app
  //
  // Also auto-launch when the URL carries ?launch=social_trainer.
  useEffect(() => {
    (window as any).__startSocialBot = () => {
      console.log("[SocialBot] __startSocialBot() invoked");
      launchApp("social_trainer");
    };
    (window as any).__stopSocialBot = () => {
      console.log("[SocialBot] __stopSocialBot() invoked");
      dismissApp();
    };
    const url = new URL(window.location.href);
    if (url.searchParams.get("launch") === "social_trainer") {
      console.log("[SocialBot] ?launch=social_trainer URL flag detected — auto-launching");
      launchApp("social_trainer");
      // Clear so a reload doesn't relaunch automatically.
      url.searchParams.delete("launch");
      window.history.replaceState({}, "", url.toString());
    }
    return () => {
      delete (window as any).__startSocialBot;
      delete (window as any).__stopSocialBot;
    };
  }, [launchApp, dismissApp]);

  // Mouth flap while the peer's OWN voice plays. Layered sines give a
  // speech-like cadence without an audio analyser tap. Gated to the "avatar"
  // audio tag so the mouth stays still while the STUDENT's button-press
  // utterance (tag "utterance") plays — the peer isn't speaking then.
  const [speakingLevel, setSpeakingLevel] = useState(0);
  useEffect(() => {
    if (!active || !isPlaying || audioPlayingTag !== "avatar") {
      setSpeakingLevel(0);
      return;
    }
    const timer = setInterval(() => {
      const t = performance.now() / 1000;
      const level = 0.3 + 0.35 * Math.abs(Math.sin(t * 7)) + 0.2 * Math.abs(Math.sin(t * 13 + 1));
      setSpeakingLevel(Math.min(1, level));
    }, SPEAKING_TICK_MS);
    return () => {
      clearInterval(timer);
      setSpeakingLevel(0);
    };
  }, [active, isPlaying, audioPlayingTag]);

  // Cave click — end the session. dismissApp() clears the local app and
  // sends app_dismissed; the server tears down the peer, restores the
  // companion Speaker, and runs the debrief.
  const cancel = useCallback(() => {
    if (!active) return;
    dismissApp();
  }, [active, dismissApp]);

  const value: SocialBotContextValue = {
    active,
    connected,
    // The director's per-turn face target is authoritative; the emote
    // mapping is only a fallback before the first turn lands.
    faceTarget: socialPeerState?.target ?? EMOTE_FACE[emote] ?? NEUTRAL_FACE,
    appearance: socialSession?.appearance ?? null,
    expressiveness: socialSession?.expressiveness ?? 0.85,
    legibility: socialSession?.legibility ?? 1,
    speakingLevel,
    // The peer's own line, carried on the per-turn social_peer_state — NOT the
    // shared currentMessage (which holds the user's input / companion text).
    botText: active ? (socialPeerState?.text ?? "") : "",
    voiceName: socialSession?.voiceName ?? null,
    characterName: socialSession?.characterName ?? null,
    cancel,
  };

  return <SocialBotContext.Provider value={value}>{children}</SocialBotContext.Provider>;
}

export function useSocialBot(): SocialBotContextValue {
  const ctx = useContext(SocialBotContext);
  if (!ctx) {
    // Provider not mounted — return an inert handle so downstream code
    // (DualAgentConversationBox) can render the same paths whether or not
    // the social-bot system is wired in.
    return {
      active: false,
      connected: false,
      faceTarget: NEUTRAL_FACE,
      appearance: null,
      expressiveness: 0.85,
      legibility: 1,
      speakingLevel: 0,
      botText: "",
      voiceName: null,
      characterName: null,
      cancel: () => {},
    };
  }
  return ctx;
}
