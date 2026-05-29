// client-aac/src/contexts/SocialBotContext.tsx
//
// Hosts the social-bot session and coordinates with the AAC dual-agent
// when activeApp = "social_trainer". Sits inside DualAgentProvider so it
// can read/write mute state, send debrief messages, and forward AAC
// utterances to the bot.
//
// What this owns:
//   - WS lifecycle (via useSocialBotSession)
//   - Save/restore muteState across the session
//   - Forward AAC AI utterances → bot text_message (debounced on
//     utteranceText settling, since utterance streams in fragments)
//   - On bot session_end: restore mute, dismiss app, send AAC AI a
//     debrief system message
//   - Expose state to DualAgentConversationBox for header rendering
//   - Cancel hook for the cave-click handler

import { createContext, useCallback, useContext, useEffect, useRef, type ReactNode } from "react";
import { useDualAgentContext } from "./DualAgentContext";
import { useSocialBotSession, type SocialBotSessionEnd } from "@/hooks/useSocialBotSession";
import { NEUTRAL_FACE, type FaceTarget, type FaceAppearance } from "@shared/social-bot/ProceduralFace";

interface SocialBotContextValue {
  /** True while a social training session is active. */
  active: boolean;
  /** True once the bot's WS handshake has completed. */
  connected: boolean;
  /** Where the face should be heading — client lerps from current. */
  faceTarget: FaceTarget;
  /** Procedural appearance fixed for this session. Null until initialized. */
  appearance: FaceAppearance | null;
  expressiveness: number;
  legibility: number;
  /** Instantaneous mouth amplitude (0..1) for lip-sync on the face. */
  speakingLevel: number;
  /** Latest bot line — replaces the AI's text in the header. */
  botText: string;
  voiceName: string | null;
  characterName: string | null;
  /** Cancel the active session (cave click). No-op when not active. */
  cancel: () => void;
}

const SocialBotContext = createContext<SocialBotContextValue | null>(null);

// Long-stop fallback: if no student-voice TTS audio EVER plays for the
// current utterance, ship the text after this long. Covers TTS-disabled
// and audio-context-blocked cases. Set generously because the audio
// player only flips `isPlaying=true` AFTER it has decoded the first
// chunk and started a BufferSourceNode — easily 200-800ms of latency
// from text arrival to isPlaying going true. We must not race that.
const TTS_AWAIT_GRACE_MS = 3000;

interface ProviderProps {
  studentId: string | null;
  children: ReactNode;
}

export function SocialBotProvider({ studentId, children }: ProviderProps) {
  const {
    activeApp,
    dismissApp,
    muteState,
    setMuteState,
    notifySocialTrainerStarted,
    notifySocialTrainerPeerSaid,
    notifySocialTrainerEnded,
    utteranceText,
    isPlaying,
    launchApp,
  } = useDualAgentContext();

  const active = activeApp?.appId === "social_trainer";

  // Bot just finished a turn — tell the AAC server (which composes the
  // [social peer just said] prompt itself and triggers a board rebuild).
  const onBotTurnComplete = useCallback(
    (text: string) => {
      if (!active) return;
      console.log("[SocialBot] bot turn complete — notifying AAC", { text });
      notifySocialTrainerPeerSaid(text);
    },
    [active, notifySocialTrainerPeerSaid],
  );

  // Trace activation transitions so we can see whether open_app(social_trainer)
  // actually fired and was received here.
  useEffect(() => {
    console.log("[SocialBot] activation change", {
      active,
      activeAppId: activeApp?.appId ?? null,
      studentId,
    });
  }, [active, activeApp?.appId, studentId]);

  // Debug helpers. Expose manual launch/dismiss on `window` so the social
  // bot WS can be tested without depending on the AAC AI's discretion.
  //
  // In the browser console:
  //   window.__startSocialBot()    // flip activeApp to social_trainer
  //   window.__stopSocialBot()     // dismiss the active app
  //
  // Also auto-launch when the URL carries ?launch=social_trainer — useful
  // when the AAC AI is uncooperative or to repro a session quickly.
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

  const session = useSocialBotSession({ studentId, active, onBotTurnComplete });

  // On activation: force the AAC AI into silent/muted mode and notify
  // the AAC server that a social-training session is starting. The
  // server composes the actual prompt (wording lives in
  // server/services/social-bot/aac-bridge-prompts.ts).
  const activatedRef = useRef(false);
  useEffect(() => {
    if (!active) return;
    if (activatedRef.current) return;
    activatedRef.current = true;
    if (muteState !== "muted") {
      setMuteState("muted");
    }
    notifySocialTrainerStarted();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  // On session end (bot- or user-initiated): restore mute, dismiss app,
  // send the AAC AI a debrief message. Run-once guard so we don't
  // re-dispatch on every render while sessionEnd is set.
  const handledEndRef = useRef(false);
  const sessionEnd = session.sessionEnd;
  useEffect(() => {
    if (!active || !sessionEnd || handledEndRef.current) return;
    handledEndRef.current = true;

    finishSession(sessionEnd);

    function finishSession(end: SocialBotSessionEnd) {
      // Always leave silent/muted mode on session end, regardless of the
      // prior state. The post-session debrief is an active conversation
      // between the AAC AI and the student — silent mode would suppress
      // the AAC AI's voice and leave the student waiting in silence.
      setMuteState("unmuted");
      // Server composes the debrief from the report + feedback summary.
      notifySocialTrainerEnded(end.report, end.feedback_summary);
      dismissApp();
    }
  }, [active, sessionEnd, dismissApp, setMuteState, notifySocialTrainerEnded]);

  // Reset the activation latches when the session is fully torn down so
  // the next launch starts clean.
  useEffect(() => {
    if (active) return;
    activatedRef.current = false;
    handledEndRef.current = false;
  }, [active]);

  // Forward settled utterances to the bot.
  //
  // `utteranceText` from useLiveSession is APPEND-ONLY across the whole
  // chat session (only reset on clearSession), and both AAC paths feed
  // into it:
  //   - Buttons + voiceButtons: server streams `utterance` chunks that
  //     get appended over the course of one turn.
  //   - Sentence builder glyph_press: server calls interpret(), then
  //     sends one `utterance` event with the full interpreted sentence.
  // Either way we want to forward only the NEW SUFFIX since the last
  // ship, not the entire accumulated buffer. We track the high-water
  // mark per session and reset it whenever `active` flips.
  const shippedThroughRef = useRef("");
  useEffect(() => {
    // Reset cursor on each fresh activation so the next session starts clean.
    if (!active) shippedThroughRef.current = "";
  }, [active]);

  // Pull stable primitives off the session handle so effects don't refire
  // on every render of the parent (the dual-agent provider churns a lot).
  const connectedFlag = session.connected;
  const sendUtterance = session.sendUtterance;
  const sessionCancel = session.cancel;

  // Forward the student's utterance to the bot AFTER the student-voice TTS
  // has finished playing — not when the text settles.
  //
  // Why: the AAC button press generates BOTH a text utterance and TTS audio
  // (the student's voice saying the words out loud). If we ship the text to
  // the bot the moment it settles, the bot replies while the student-voice
  // is still mid-sentence, which feels wrong and breaks echo cancellation
  // assumptions (the bot's input clock should match real-world speech
  // timing). Instead, we wait for the TTS audio to drain (isPlaying true →
  // false) and forward the accumulated delta then.
  //
  // Fallback: if isPlaying never went true for this turn (e.g. TTS is
  // disabled or audio context blocked), fire a settle timer so we don't
  // strand the utterance entirely.
  const lastPlayingRef = useRef(false);
  const sawPlayingThisTurnRef = useRef(false);

  // Track isPlaying transitions in a ref so we don't put isPlaying directly
  // in the forwarding effect's deps (it flips constantly).
  useEffect(() => {
    if (isPlaying) sawPlayingThisTurnRef.current = true;
    lastPlayingRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    if (!active || !connectedFlag) return;
    if (!utteranceText) return;

    const cursor = shippedThroughRef.current;
    const delta = utteranceText.startsWith(cursor)
      ? utteranceText.slice(cursor.length).trim()
      : utteranceText.trim();
    if (!delta) return;

    // Two cases:
    //   (a) Audio is playing now, OR will start playing for this utterance.
    //       The isPlaying false-edge watcher (below) will ship when TTS
    //       finishes. We do nothing here.
    //   (b) No TTS at all for this utterance (TTS disabled / audio context
    //       blocked / unusual race). The grace timer below ships as a
    //       last resort, but ONLY if isPlaying never went true. If audio
    //       did play and the false-edge watcher already shipped, this
    //       fallback would double-send — guard against that with
    //       sawPlayingThisTurnRef.
    if (isPlaying) {
      console.log("[SocialBot] utterance delta — awaiting TTS finish", { delta });
      return;
    }

    console.log("[SocialBot] utterance delta — waiting for TTS to start", { delta });
    const timer = setTimeout(() => {
      // If audio is currently playing or ever played for this utterance,
      // the false-edge watcher owns shipping. Bail.
      if (lastPlayingRef.current) return;
      if (sawPlayingThisTurnRef.current) return;

      // Re-check the delta at fire time (utteranceText may have grown).
      const current = utteranceText;
      const c = shippedThroughRef.current;
      const finalDelta = current.startsWith(c) ? current.slice(c.length).trim() : current.trim();
      if (!finalDelta) return;
      shippedThroughRef.current = current;
      console.log("[SocialBot] utterance shipped (no-TTS fallback)", { delta: finalDelta });
      sendUtterance(finalDelta);
    }, TTS_AWAIT_GRACE_MS);

    return () => clearTimeout(timer);
  }, [active, connectedFlag, utteranceText, isPlaying, sendUtterance]);

  // isPlaying false-edge watcher: when TTS finishes after we've staged a
  // delta, ship it. Lives separately so utteranceText updates don't fight
  // the timer logic above.
  const prevIsPlayingForShipRef = useRef(false);
  useEffect(() => {
    const wasPlaying = prevIsPlayingForShipRef.current;
    prevIsPlayingForShipRef.current = isPlaying;
    if (!active || !connectedFlag) return;
    if (!wasPlaying || isPlaying) return; // only true → false

    const current = utteranceText ?? "";
    const c = shippedThroughRef.current;
    const finalDelta = current.startsWith(c) ? current.slice(c.length).trim() : current.trim();
    if (!finalDelta) return;
    shippedThroughRef.current = current;
    sawPlayingThisTurnRef.current = false;
    console.log("[SocialBot] utterance shipped on TTS end", { delta: finalDelta });
    sendUtterance(finalDelta);
  }, [active, connectedFlag, isPlaying, utteranceText, sendUtterance]);

  const cancel = useCallback(() => {
    sessionCancel();
  }, [sessionCancel]);

  const value: SocialBotContextValue = {
    active,
    connected: session.connected,
    faceTarget: session.faceTarget,
    appearance: session.appearance,
    expressiveness: session.expressiveness,
    legibility: session.legibility,
    speakingLevel: session.speakingLevel,
    botText: session.botText,
    voiceName: session.voiceName,
    characterName: session.characterName,
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
