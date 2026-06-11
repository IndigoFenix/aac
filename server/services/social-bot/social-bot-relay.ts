// server/services/social-bot/social-bot-relay.ts
//
// Live relay for the Social Training Game bot.
//
// Architecture (post-2026-05-29 rewrite):
//   - The bot's affect state, identity, learner profile, and shared
//     history all live in a per-session DirectedSession (./directed-session.ts).
//   - The director is deterministic: per turn, it builds a directive,
//     calls a TEXT-mode LLM with a forced `turn` tool (reply + observed),
//     applies impulses, and steps its springs. The LLM never decides
//     mood, rapport, or whether it likes the user.
//   - The reply text is streamed through Gemini TTS to produce audio.
//     Native-audio Live API is gone — we lose some prosody but gain
//     full structural control over the bot's behavior.
//
// Wire protocol:
//   client → server: initialize { studentId }, text_message { data }, cancel
//   server → client: initialized, bot_state (face target + mode),
//                    bot_text (transcript), bot_audio (base64 WAV chunks),
//                    turn_complete, session_report, error

import type { IncomingMessage, Server } from "http";
import { WebSocket, WebSocketServer } from "ws";
import { GoogleGenAI } from "@google/genai";
import { authenticateUpgrade } from "../realtime/ws-auth";
import { studentService } from "../studentService";
import { logLiveSession } from "../dual-agent/dual-agent-logger";
import { ttsFacade, type ResolvedVoice } from "../voice/tts-facade";
import type { User } from "@shared/schema";
import { randomAppearance } from "@shared/social-bot/ProceduralFace";
import { getLanguageName } from "@shared/language-names";
import type {
  BotStatePayload,
  CompetencySnapshot,
  Competency,
  SessionReport,
  SharedMomentSummary,
} from "@shared/social-bot/state";
import { DirectedSession, DIRECTED_SESSION_DEFAULT_MODEL } from "./directed-session";
import { dualAgentService } from "../dual-agent/dual-agent-service";
import {
  describePersona,
  generatePersona,
  DEFAULT_DIFFICULTY,
  DEFAULT_SLP_CONFIG,
} from "./persona-generator";

import { pickVoice } from "./voice-pick";
import { buildSocialBotGenAIClient } from "./genai-client";

const FLUSH_INTERVAL_MS = 250;
/** Hard cap on TTS time before we give up on the turn. */
const TTS_TIMEOUT_MS = 10_000;

const COMPETENCIES: Competency[] = [
  "responsiveness",
  "reciprocity",
  "attunement",
  "repair",
  "assertiveness",
  "complimentCalibration",
  "initiation",
  "interestEngagement",
];

export class SocialBotRelay {
  private ws: WebSocket;
  private authedUser: User;
  private ai: GoogleGenAI;
  private studentId: string | null = null;
  private voiceName: string | null = null;
  private language = "en";
  private session: DirectedSession | null = null;
  private personaName = "";
  private expressiveness = 0.85;
  private legibility = 1;
  private startedAt = Date.now();
  private sessionId = `social-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  private reportSent = false;
  /** Tracks an in-flight TTS so cancel can interrupt it. */
  private ttsAbort: AbortController | null = null;
  /** Most recent in-character closing line (set if bot ever produces one). */
  private lastFeedbackLine = "";

  constructor(ws: WebSocket, user: User) {
    this.ws = ws;
    this.authedUser = user;
    logLiveSession(
      "SOCIAL BOT",
      `constructor entered sessionId=${this.sessionId} user=${user.id}`,
    );

    try {
      this.ai = this.buildClient();
    } catch (err: any) {
      logLiveSession("SOCIAL BOT ERROR", `buildClient threw: ${err.message || err}`);
      throw err;
    }

    ws.on("message", (raw) => {
      const text = raw.toString();
      try {
        const msg = JSON.parse(text);
        logLiveSession("SOCIAL BOT: CLIENT → SERVER", `type=${msg.type ?? "(none)"}`);
        this.handleClientMessage(msg).catch((err) => {
          logLiveSession("SOCIAL BOT: handleClientMessage threw", err.message || String(err));
        });
      } catch (err: any) {
        logLiveSession("SOCIAL BOT: parse error", err.message || String(err));
      }
    });

    ws.on("close", (code, reason) => {
      logLiveSession(
        "SOCIAL BOT CLOSE",
        `sessionId=${this.sessionId} code=${code} reason="${reason?.toString() || ""}"`,
      );
      this.cleanup();
    });

    ws.on("error", (err) => {
      logLiveSession("SOCIAL BOT WS ERROR", err.message || String(err));
      this.cleanup();
    });
  }

  private buildClient(): GoogleGenAI {
    return buildSocialBotGenAIClient();
  }

  private send(msg: any): void {
    if (this.ws.readyState === WebSocket.OPEN) {
      const summary: any = { type: msg.type };
      if (typeof msg.data === "string" && msg.data.length > 100) summary.dataLen = msg.data.length;
      else if (msg.data !== undefined && msg.type !== "bot_audio") summary.data = msg.data;
      logLiveSession("SOCIAL BOT: SERVER → CLIENT", JSON.stringify(summary));
      this.ws.send(JSON.stringify(msg));
    }
  }

  private async handleClientMessage(msg: any): Promise<void> {
    switch (msg.type) {
      case "initialize":
        await this.handleInitialize(msg);
        break;
      case "text_message":
        if (this.session && typeof msg.data === "string") {
          await this.handleUserTurn(msg.data);
        } else {
          logLiveSession(
            "SOCIAL BOT: text_message dropped",
            `hasSession=${!!this.session} hasData=${typeof msg.data === "string"}`,
          );
        }
        break;
      case "cancel":
        this.handleCancel();
        break;
      default:
        logLiveSession("SOCIAL BOT: UNKNOWN MESSAGE", `type=${msg.type}`);
    }
  }

  private async handleInitialize(msg: any): Promise<void> {
    // studentId is OPTIONAL. When provided, we look up the student to get
    // their language and exclude their AAC voices from the bot's voice
    // pick (so the bot doesn't sound identical to either of their normal
    // voices). When absent, this is the standalone test path — auth is
    // still required (authenticateUpgrade gates the WS), but no AAC
    // student record exists and the bot will mirror whatever language
    // the user uses.
    // Optional generator overrides from the standalone game UI. AAC mode
    // ignores these and lets the procedural defaults roll.
    const params = (msg.params && typeof msg.params === "object") ? msg.params : {};
    const archetypeParam = typeof params.archetype === "string" ? params.archetype : undefined;
    const genderParam = params.gender === "male" || params.gender === "female" ? params.gender : undefined;
    const difficultyParam = typeof params.difficulty === "number"
      ? Math.max(0, Math.min(1, params.difficulty))
      : DEFAULT_DIFFICULTY;

    // Procedural persona FIRST — its gender drives voice selection.
    const persona = generatePersona({
      archetype: archetypeParam as any,
      gender: genderParam,
    });
    this.personaName = persona.name;

    let promptLanguage: string | null = null;
    let voiceExclusions: ReadonlyArray<string | undefined | null> = [];
    if (msg.studentId) {
      const access = await studentService.verifyStudentAccess(msg.studentId, this.authedUser.id);
      if (!access.hasAccess) {
        logLiveSession("SOCIAL BOT", `access denied user=${this.authedUser.id} student=${msg.studentId}`);
        this.send({ type: "error", data: "FORBIDDEN_STUDENT" });
        this.ws.close(1008, "forbidden");
        return;
      }
      this.studentId = msg.studentId;
      const student = await studentService.getStudentById(msg.studentId);
      this.language = student?.primaryLanguage || "en";
      promptLanguage = getLanguageName(this.language);
      const aac = student?.aacSettings as any;
      voiceExclusions = [aac?.geminiAiVoice, aac?.geminiStudentVoice];
    } else {
      // Standalone mode — no student record. The client tells us which
      // language it set its STT to via params.language; use that as the
      // ground truth so prompt + TTS line up with what the user is
      // actually speaking (no more "stuck in Hebrew" surprises).
      this.studentId = null;
      const langCode = typeof params.language === "string" ? params.language : "en";
      this.language = langCode;
      promptLanguage = getLanguageName(langCode);
      logLiveSession("SOCIAL BOT", `standalone session — no studentId, language=${langCode}`);
    }
    // Gender-matched voice, excluding any AAC voices the student already
    // hears in their day-to-day session.
    this.voiceName = pickVoice(persona.gender, voiceExclusions);


    this.expressiveness = persona.genome.expressiveness;
    // legibility drops with difficulty (mirrors deriveParams' formula)
    this.legibility = Math.max(0, Math.min(1, persona.genome.expressiveness - 0.45 * difficultyParam));

    this.session = new DirectedSession(this.ai, {
      name: persona.name,
      gender: persona.gender,
      genome: persona.genome,
      identity: persona.identity,
      appearance: persona.appearance,
      humorStyle: persona.humorStyle,
      slp: DEFAULT_SLP_CONFIG,
      difficulty: difficultyParam,
      // Prompt-facing language: resolved English name (e.g. "Hebrew") for
      // AAC sessions, null for standalone (bot mirrors the user instead).
      // TTS still uses the code via `this.language` separately.
      language: promptLanguage,
    });

    this.startedAt = Date.now();
    logLiveSession(
      "SOCIAL BOT init",
      `student=${this.studentId} lang=${this.language} voice=${this.voiceName} ${describePersona(persona)}`,
    );

    // Pass the appearance through to the client only after the persona has
    // been logged so a debugger can correlate.
    const appearance = persona.appearance;

    this.send({
      type: "initialized",
      sessionId: this.sessionId,
      characterName: persona.name,
      voiceName: this.voiceName,
      language: this.language,
      appearance,
      expressiveness: this.expressiveness,
      legibility: this.legibility,
    });

    // Initial face target (neutral baseline) so the client renders something
    // sensible before the first turn lands.
    this.send({
      type: "bot_state",
      data: this.buildStatePayload(),
    });
  }

  /** Shape the live face state into the client's wire payload. */
  private buildStatePayload(target?: ReturnType<DirectedSession["initialFaceTarget"]>, mode?: string, rapport?: number): BotStatePayload {
    if (!this.session) {
      // Shouldn't happen — caller only invokes after session exists.
      return {
        target: { v: 0, a: 0, r: 0, smirk: 0, gx: 0, gy: 0 },
        mode: "NEUTRAL",
        rapport: 0,
      };
    }
    const t = target ?? this.session.initialFaceTarget();
    const m = (mode as BotStatePayload["mode"]) ?? this.session.initialMode();
    return {
      target: t,
      mode: m,
      rapport: rapport ?? t.r,
    };
  }

  private async handleUserTurn(transcript: string): Promise<void> {
    if (!this.session) return;
    const cleaned = transcript.trim();
    if (!cleaned) return;

    logLiveSession("SOCIAL BOT: USER TURN", `"${cleaned.slice(0, 200)}"`);

    let result;
    try {
      result = await this.session.handleTurn(cleaned);
    } catch (err: any) {
      logLiveSession("SOCIAL BOT: LLM turn failed", err.message || String(err));
      this.send({ type: "error", data: "LLM_TURN_FAILED" });
      return;
    }

    // Bill the turn's tokens to the USER alone — the standalone trainer
    // has no chat_sessions row, and even when a studentId was passed for
    // voice/language resolution the practice run isn't a student session.
    if (result.usage) {
      dualAgentService.trackHttpUsage(
        "",
        "",
        this.authedUser.id,
        "gemini",
        DIRECTED_SESSION_DEFAULT_MODEL,
        result.usage.promptTokens,
        result.usage.completionTokens,
        result.usage.cachedTokens ?? 0,
        "social-bot-standalone",
      ).catch((err) => logLiveSession("SOCIAL BOT: usage tracking failed", err?.message || String(err)));
    }

    // Push the new state to the client immediately so the face starts
    // moving toward the new target while TTS spins up.
    this.send({
      type: "bot_state",
      data: this.buildStatePayload(result.faceTarget, result.mode, result.vector.rapport),
    });
    this.send({ type: "bot_text", data: result.reply });

    // Stream the reply through TTS. Each WAV chunk goes straight to the
    // client as bot_audio. We send a turn_complete marker after the
    // stream finishes so the client knows the bot's audio is done.
    this.lastFeedbackLine = result.reply;
    await this.streamTtsToClient(result.reply);
    this.send({ type: "turn_complete" });
  }

  private async streamTtsToClient(text: string): Promise<void> {
    if (!text || !this.voiceName) return;
    this.ttsAbort?.abort();
    const aborter = new AbortController();
    this.ttsAbort = aborter;

    // Route through ttsFacade: Gemini TTS first (random voice we picked),
    // automatic fallback to Google Cloud TTS if Gemini TTS fails or hangs.
    // Without the fallback, a Gemini TTS hiccup means the bot is silent
    // for that whole turn — what the user was hitting.
    const voice: ResolvedVoice = {
      fallbackType: "woman",
      customVoice: null,
      language: this.language,
      geminiVoiceName: this.voiceName,
    };

    // Overall timeout: if TTS hasn't drained by TTS_TIMEOUT_MS, bail.
    const t0 = Date.now();
    const timeoutId = setTimeout(() => {
      if (!aborter.signal.aborted) {
        logLiveSession(
          "SOCIAL BOT: TTS timeout",
          `elapsed=${Date.now() - t0}ms text="${text.slice(0, 60)}"`,
        );
        aborter.abort();
      }
    }, TTS_TIMEOUT_MS);

    let firstChunkAt = 0;
    let chunkCount = 0;
    try {
      // Per-synthesis billing — user-only, same attribution as the LLM
      // turns (no session/student rows for the standalone trainer).
      const stream = ttsFacade.synthesizeStream(text, voice, aborter.signal, (usage) => {
        dualAgentService.trackTtsUsage("", "", this.authedUser.id, usage.provider, usage.characters)
          .catch((err) => logLiveSession("SOCIAL BOT: TTS usage tracking failed", err?.message || String(err)));
      });
      for await (const wav of stream) {
        if (aborter.signal.aborted) {
          logLiveSession("SOCIAL BOT: TTS aborted mid-stream", `chunks=${chunkCount}`);
          return;
        }
        if (chunkCount === 0) {
          firstChunkAt = Date.now() - t0;
          logLiveSession("SOCIAL BOT: TTS first chunk", `firstChunkMs=${firstChunkAt}`);
        }
        chunkCount += 1;
        this.send({ type: "bot_audio", data: wav.toString("base64"), format: "wav" });
      }
      logLiveSession(
        "SOCIAL BOT: TTS done",
        `chunks=${chunkCount} firstMs=${firstChunkAt} totalMs=${Date.now() - t0}`,
      );
    } catch (err: any) {
      logLiveSession(
        "SOCIAL BOT: TTS stream failed",
        `${err.message || String(err)} chunks=${chunkCount}`,
      );
    } finally {
      clearTimeout(timeoutId);
      if (this.ttsAbort === aborter) this.ttsAbort = null;
    }
  }

  private handleCancel(): void {
    logLiveSession("SOCIAL BOT", "cancel received");
    this.ttsAbort?.abort();
    this.finalizeSession("Cancelled by the user.");
  }

  private finalizeSession(feedback?: string): void {
    if (this.reportSent) return;
    this.reportSent = true;
    const report = this.buildReport(feedback || this.lastFeedbackLine);
    this.send({ type: "session_report", data: { report, feedback_summary: report.feedbackSummary } });
    setTimeout(() => {
      try { this.ws.close(1000, "session ended"); } catch { /* ignore */ }
    }, 500);
  }

  private buildReport(feedbackSummary: string): SessionReport {
    const inspect = this.session?.inspect();
    const competencies: CompetencySnapshot[] = inspect
      ? COMPETENCIES.map((c) => ({
          competency: c,
          value: inspect.profile.skills[c].value,
          samples: inspect.profile.skills[c].samples,
        }))
      : [];
    const moments: SharedMomentSummary[] = inspect
      ? inspect.moments.map((m) => ({ kind: m.kind, summary: m.summary, weight: m.weight }))
      : [];
    return {
      characterName: this.personaName,
      durationMs: Date.now() - this.startedAt,
      turnIndex: inspect?.turnIndex ?? 0,
      finalMode: (inspect?.mode as BotStatePayload["mode"]) ?? "NEUTRAL",
      finalRapport: inspect?.vector.rapport ?? 0,
      competencies,
      moments,
      feedbackSummary,
    };
  }

  private cleanup(): void {
    this.ttsAbort?.abort();
    this.ttsAbort = null;
    this.session = null;
  }
}

// ── WebSocket mount ─────────────────────────────────────────────────────────

export function setupSocialBotWebSocket(server: Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req: IncomingMessage, socket, head) => {
    const url = new URL(req.url || "", `http://${req.headers.host}`);
    if (url.pathname !== "/ws/social-bot") return;

    logLiveSession(
      "SOCIAL BOT UPGRADE",
      `incoming pathname=${url.pathname} host=${req.headers.host || ""}`,
    );

    let user;
    try {
      user = await authenticateUpgrade(req);
    } catch (err: any) {
      logLiveSession("SOCIAL BOT UPGRADE", `authenticateUpgrade threw: ${err.message || err}`);
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
      return;
    }
    if (!user) {
      logLiveSession("SOCIAL BOT UPGRADE", "401 — authenticateUpgrade returned null");
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(req, socket as any, head as any, (ws) => {
      try {
        new SocialBotRelay(ws as any, user);
      } catch (err: any) {
        logLiveSession("SOCIAL BOT UPGRADE", `relay constructor threw: ${err.message || err}`);
        try { ws.close(1011, "relay init failed"); } catch { /* ignore */ }
      }
    });
  });

  console.log("[SocialBotRelay] WebSocket server ready on /ws/social-bot");
  logLiveSession("SOCIAL BOT STARTUP", "setupSocialBotWebSocket — upgrade listener attached on /ws/social-bot");
}
