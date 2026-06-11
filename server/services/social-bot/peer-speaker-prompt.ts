// server/services/social-bot/peer-speaker-prompt.ts
//
// Post-session support for the AAC-integrated social trainer.
//
// The peer itself is the director-driven SocialPeerSpeakerAgent
// (peer-speaker-agent.ts) — its in-conversation prompt is the standalone
// engine's session prefix (prompt-assembly.ts). This file owns what
// happens AFTER the session:
//   - buildSocialDebriefDirective — the [SYSTEM] turn handed to the
//     RESTORED companion Speaker so it discusses the conversation with
//     the user, folding in the director's SessionReport
//   - runSocialSkillAnalysis — one HTTP LLM call over the session
//     transcript producing a short qualitative coach read that
//     complements the director's quantitative competency snapshot

import { getChatProvider } from "../providers/provider-factory";
import type { ChatMessage } from "../providers/streaming-provider";
import type { LLMProviderKey } from "@shared/llm-options";
import { COMPETENCY_LABEL, type SessionReport } from "@shared/social-bot/state";

// ---------------------------------------------------------------------------
// Post-session debrief directive (for the restored companion Speaker)
// ---------------------------------------------------------------------------

/** Render the director's structured report into prompt-friendly lines.
 *  Mirrors the standalone aac-bridge debrief: competencies with enough
 *  samples (weakest first, as percentages) + the last shared moments. */
function renderReportLines(report: SessionReport): string[] {
  const lines: string[] = [];
  lines.push(
    `The session ran ${report.turnIndex} turns; final rapport was ${report.finalRapport.toFixed(2)} (mode: ${report.finalMode.toLowerCase()}).`,
  );
  const relevant = report.competencies
    .filter((c) => c.samples >= 3)
    .sort((a, b) => a.value - b.value);
  if (relevant.length > 0) {
    lines.push(`Per-skill snapshot (weakest first):`);
    for (const c of relevant) {
      const pct = Math.round(c.value * 100);
      lines.push(`  - ${COMPETENCY_LABEL[c.competency]}: ${pct}%`);
    }
  }
  if (report.moments.length > 0) {
    lines.push(`Moments worth referencing:`);
    for (const m of report.moments.slice(-3)) {
      lines.push(`  - (${m.kind}) ${m.summary}`);
    }
  }
  return lines;
}

export function buildSocialDebriefDirective(
  characterName: string,
  analysis?: string | null,
  report?: SessionReport | null,
): string {
  const lines: string[] = [
    `[SYSTEM] The user just finished a social-practice conversation with a virtual peer named ${characterName}.`,
    `The conversation is in your history — the peer's lines are tagged [${characterName} (virtual peer)]. The peer was an AI character; you were not part of that conversation.`,
  ];
  if (report) {
    lines.push(``, ...renderReportLines(report));
  }
  if (analysis && analysis.trim()) {
    lines.push(``, `A coach's read of the session:`, analysis.trim());
  }
  lines.push(
    ``,
    `Talk it over with the user now, warmly and briefly:`,
    `  - Mention one or two specific things that went well.`,
    `  - Offer ONE gentle thing to try next time.`,
    `  - You are a supportive coach, not a grader — never read scores or percentages aloud.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Social-skill analysis (one HTTP LLM call over the session transcript)
// ---------------------------------------------------------------------------

export interface SocialSkillAnalysisResult {
  analysis: string | null;
  usage?: {
    promptTokens: number;
    completionTokens: number;
    cachedTokens?: number;
    cacheCreationTokens?: number;
  };
}

const ANALYSIS_SYSTEM_PROMPT = [
  `You are a speech-language coach reviewing a short practice conversation between a student (USER) and a virtual peer character.`,
  `The student communicates through an AAC device — button presses are real utterances.`,
  `Assess the STUDENT's social skills only; the peer is scripted.`,
  ``,
  `Cover, where the transcript gives evidence:`,
  `  - responsiveness (did they answer what was asked?)`,
  `  - reciprocity (asking back, sharing about themselves)`,
  `  - initiation (starting topics, greetings, goodbyes)`,
  `  - repair and warmth (recovering from misunderstandings, friendly tone)`,
  ``,
  `Output rules:`,
  `  - 3-6 short bullet observations, quoting brief moments where useful.`,
  `  - End with ONE suggested focus for next time.`,
  `  - Under 150 words. Plain text, in English. Supportive, concrete, no scores.`,
].join("\n");

export async function runSocialSkillAnalysis(opts: {
  providerKey: LLMProviderKey;
  model: string;
  characterName: string;
  /** Conversation lines in order, already speaker-tagged. */
  transcript: string[];
}): Promise<SocialSkillAnalysisResult> {
  const usable = opts.transcript.filter(l => l.trim());
  if (usable.length === 0) return { analysis: null };

  const messages: ChatMessage[] = [
    { role: "system", content: ANALYSIS_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Peer character: ${opts.characterName}`,
        `Transcript:`,
        ...usable,
      ].join("\n"),
    },
  ];

  const provider = getChatProvider(opts.providerKey);
  const result = await provider.completeChat({
    model: opts.model,
    messages,
    temperature: 0.4,
    maxTokens: 400,
  });
  return {
    analysis: result.content?.trim() || null,
    usage: result.usage,
  };
}
