// server/services/social-bot/aac-bridge-prompts.ts
//
// Prompts the AAC AI receives when a social-trainer session is running.
//
// These compose system messages that are sent into the AAC live-relay's
// LLM as user-role text (so they complete a turn and force the AI to
// react — e.g. rebuild the response board). The client just sends
// semantic events; the wording lives here.
//
// Three events:
//   - session_started   : peer just appeared, build generic greeting board
//   - peer_said(text)   : peer just spoke, rebuild board to respond
//   - session_ended(report?, feedback?) : session over, discuss warmly
//
// The AAC AI is in muted state during the session and unmuted at end-of-
// session by SocialBotContext on the client.

import type { SessionReport } from "@shared/social-bot/state";
import { COMPETENCY_LABEL } from "@shared/social-bot/state";

export function socialTrainerStartedPrompt(): string {
  return [
    "[system: the student is starting a social training session.",
    "A peer character has appeared on screen and is waiting to talk.",
    "You do NOT know who the peer is — that is for the student to discover.",
    "Act as a facilitator: stay quiet (do not voice yourself); your only job",
    "is to generate response buttons that help the student talk to the peer.",
    "",
    "RIGHT NOW, call rebuild_board() with a generic greeting board the student",
    "can use to begin: greetings (\"Hi\", \"Hello\"), simple openers (\"How are",
    "you?\", \"What's your name?\"), ways to introduce themselves, and a couple",
    "of friendly small-talk options. Do NOT include any specific person's name",
    "in the buttons — use only generic phrasing.",
    "",
    "After this, each time the peer speaks you will receive a context line",
    "like [social peer just said] \"…\". Rebuild the board with appropriate",
    "response options each time. Do not speak.]",
  ].join(" ");
}

export function socialTrainerPeerSaidPrompt(text: string): string {
  const safe = text.replace(/"/g, '\\"').slice(0, 500);
  return [
    `[system: the social-training peer just said: "${safe}".`,
    "Rebuild the response board with utterance buttons the student could press",
    "to reply to that. Do not speak — you are muted.]",
  ].join(" ");
}

export function socialTrainerEndedPrompt(opts: { report?: SessionReport; feedbackSummary?: string }): string {
  const { report, feedbackSummary } = opts;
  const lines: string[] = [];
  lines.push("[system: the student just finished a social training session.");

  if (report?.characterName) {
    lines.push(`They were talking to ${report.characterName}.`);
  }
  if (feedbackSummary) {
    lines.push(`Peer's last in-character line: "${feedbackSummary}"`);
  }
  if (report) {
    lines.push(
      `The session ran ${report.turnIndex} turns; final rapport was ${report.finalRapport.toFixed(2)} (mode: ${report.finalMode}).`,
    );

    const relevant = report.competencies
      .filter((c) => c.samples >= 3)
      .sort((a, b) => a.value - b.value);
    if (relevant.length > 0) {
      lines.push("Per-skill snapshot:");
      for (const c of relevant) {
        const pct = Math.round(c.value * 100);
        const label = COMPETENCY_LABEL[c.competency];
        lines.push(`  • ${label}: ${pct}%`);
      }
    }

    if (report.moments.length > 0) {
      lines.push("Moments worth referencing:");
      for (const m of report.moments.slice(-3)) {
        lines.push(`  • (${m.kind}) ${m.summary}`);
      }
    }
  }

  lines.push(
    "Discuss this warmly with the user. Pick one or two highlights — what went well, and one thing",
    "they could try next time. Be supportive. Do not give a graded report; talk like a coach who cares.]",
  );

  return lines.join(" ");
}
