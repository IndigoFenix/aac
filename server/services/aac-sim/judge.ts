/**
 * judge.ts — SCORING THE RUN (harness design ⑨, law ⑧).
 *
 * THE PLAYER DOES NOT GRADE ITS OWN RUN. The child reports confusion in
 * character, turn by turn; this reads the finished transcript against the
 * scenario's stated intent and scores it. Self-grading inflates, and an
 * in-character child is the worst possible scorer of its own comprehension.
 *
 * EVERY SCORE MUST CITE A TURN. A rubric without evidence is a vibe with a
 * number on it, and a number nobody can check is worse than no number — it
 * looks trendable. The schema makes the citation required.
 */

import { getStructuredProvider } from "../providers/provider-factory.js";
import type { JSONSchema } from "../chat/gpt.js";
import type { RunTranscript } from "./runner.js";
import type { DisclosureContext } from "../processorDisclosure";

/**
 * AKIM §18.5 — the simulation's disclosure context.
 *
 * DECLARED non-PHI, not merely context-free. The "child" here is a generated
 * persona in a script: no row in `students` backs it, and nothing on the wire
 * came from a real person. Attaching this makes the recorder skip the send
 * EXPLICITLY (see NON_PHI_USE_CASES in services/processorDisclosure.ts), which
 * is the point — a genuine PHI path that merely forgot its ids still fails
 * loud, while this one is silent because someone asserted it is safe.
 */
const SIM_DISCLOSURE: DisclosureContext = { studentId: null, useCase: "aac_sim" };

/** Catalog key for the judge. Stronger than the child, and it runs once. */
export const JUDGE_MODEL = "claude-haiku";

export interface RubricScore {
  /** 0–3. */
  score: number;
  /** The turn number this is based on. */
  turn: number;
  why: string;
}

export interface JudgeReport {
  reachability: RubricScore;
  boardRelevance: RubricScore;
  comprehensibility: RubricScore;
  fidelity: RubricScore;
  responsiveness: RubricScore;
  repair: RubricScore;
  /** What actually went wrong, in the harness's voice. Empty is a valid answer. */
  findings: string[];
  summary: string;
}

const SCORE: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["score", "turn", "why"],
  properties: {
    score: { type: "number", description: "0 = broken, 1 = poor, 2 = adequate, 3 = good." },
    turn: { type: "number", description: "The turn number this judgement rests on." },
    why: { type: "string", description: "One or two sentences citing what happened on that turn." },
  },
};

const REPORT_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: [
    "reachability",
    "boardRelevance",
    "comprehensibility",
    "fidelity",
    "responsiveness",
    "repair",
    "findings",
    "summary",
  ],
  properties: {
    reachability: SCORE,
    boardRelevance: SCORE,
    comprehensibility: SCORE,
    fidelity: SCORE,
    responsiveness: SCORE,
    repair: SCORE,
    findings: {
      type: "array",
      items: { type: "string" },
      description: "Concrete defects, each naming a turn. Empty array if there were none.",
    },
    summary: { type: "string" },
  },
};

const RUBRIC = `
Score each 0-3 (0 broken, 1 poor, 2 adequate, 3 good), and cite the turn you based it on.

- reachability      Could the child get to what they MEANT? Count the presses it took and
                    whether any were wasted.
- boardRelevance    Were the buttons on offer the right ones for that moment in the
                    conversation, or generic?
- comprehensibility Could THIS child read/see what they were given? A child who cannot read
                    is shown pictures only — judge whether the pictures carried the meaning.
- fidelity          Did what the system SAID match what the child MEANT?
- responsiveness    Latency and turn-taking as the child experienced it.
- repair            When it went wrong, could the child recover?

Be strict. A run where the child never said what they meant cannot score above 1 on
reachability or fidelity, however pleasant the conversation was.`;

/**
 * Render the transcript for the judge.
 *
 * The judge sees the SCREENS the child saw, the child's own reasoning, and what
 * the device said — the same evidence a human reviewer would have. It is NOT
 * given the board objects or server internals: a judge that can see what the
 * child could not would forgive interfaces the child could not use.
 */
export function renderForJudge(t: RunTranscript): string {
  const lines: string[] = [
    `SCENARIO: ${t.scenario}`,
    `CHILD PROFILE: ${t.profile}`,
    `WHAT THE CHILD WANTED TO SAY: ${t.intent}`,
    `OUTCOME: ${t.outcome} after ${t.counters.presses} presses ` +
      `(${t.counters.localPresses} of which never reached the server, ` +
      `${t.counters.misselects} mis-selects, ${t.counters.deadEnds} dead ends)`,
    "",
  ];

  for (const turn of t.turns) {
    lines.push(`── TURN ${turn.n} ${"─".repeat(40)}`);
    lines.push(turn.screen.join("\n"));
    lines.push(
      `CHILD: ${turn.action.kind}${turn.action.n != null ? ` ${turn.action.n}` : ""} — ${turn.action.why}`,
    );
    if (turn.action.note) lines.push(`CHILD NOTED: ${turn.action.note}`);
    if (turn.aimed != null && turn.landed != null && turn.aimed !== turn.landed) {
      lines.push(`(they aimed at ${turn.aimed} and hit ${turn.landed} — a mis-select)`);
    }
    lines.push(`RESULT: ${turn.outcome}  [${turn.latencyMs}ms]`);
    lines.push("");
  }

  lines.push("EVERYTHING THE CHILD HEARD:");
  for (const h of t.heard) lines.push(`  [${h.source}] ${h.text}`);
  return lines.join("\n");
}


export async function judgeRun(
  transcript: RunTranscript,
): Promise<{
  report: JudgeReport | null;
  /** The exact payload, so a judge that returns something unusable is diagnosable. */
  raw: string;
  usage: { promptTokens: number; completionTokens: number };
}> {
  const provider = getStructuredProvider("claude");
  const res = await provider.structuredComplete({
    disclosure: SIM_DISCLOSURE,
    model: JUDGE_MODEL,
    instructions:
      "You are reviewing one session of a child using an AAC communication device. " +
      "You are judging the DEVICE, not the child. " +
      RUBRIC,
    input: [{ type: "message", role: "user", content: renderForJudge(transcript) }],
    schemaName: "judge_report",
    schema: REPORT_SCHEMA,
    maxTokens: 2000,
    temperature: 0.2,
  });

  const raw = typeof res.content === "string" ? res.content : JSON.stringify(res.content ?? null);
  const report =
    typeof res.content === "string"
      ? (safeParse(res.content) as JudgeReport | null)
      : ((res.content as JudgeReport) ?? null);

  return {
    report,
    raw,
    usage: { promptTokens: res.promptTokens ?? 0, completionTokens: res.completionTokens ?? 0 },
  };
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}
