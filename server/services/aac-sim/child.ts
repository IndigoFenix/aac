/**
 * child.ts — THE AI THAT PLAYS THE CHILD (harness design ⑦).
 *
 * Given one projected screen and a private intent, choose one action. That is
 * the whole contract; everything else is prompt.
 *
 * LAW ① IS ENFORCED BY WHAT THIS FUNCTION CAN SEE. It takes RENDERED LINES, not
 * the model, not the session, not the board object. There is no field it could
 * accidentally read: if a fact is not in the projection, the child cannot know
 * it. Passing the `SimClientModel` here "for convenience" would quietly undo the
 * entire fidelity argument, so it does not take one.
 *
 * LAW ⑧ — the child never scores itself. It reports confusion in character, one
 * turn at a time; a separate judge reads the transcript afterwards.
 *
 * ⚠️ The child is a DIFFERENT MODEL on a DIFFERENT conversation from the system
 * under test (law ⑤). It shares no prompt cache and no context with the agents;
 * its cost is tracked separately by the runner.
 */

import { getStructuredProvider } from "../providers/provider-factory.js";
import type { JSONSchema } from "../chat/gpt.js";
import type { ChildProfile } from "@shared/aac/sim-profiles";
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

/** The catalog key for the child model — cheapest per token of the Gemini tier. */
export const CHILD_MODEL = "gemini-2.5-flash";

/** One decision. `press` names a number printed on the screen. */
export interface ChildAction {
  /**
   * press — press the numbered cell.
   * wait  — do nothing this turn and let the world move (the child is thinking,
   *         or waiting for a reply that has not come).
   * done  — the child believes they have said what they meant.
   * stuck — the child cannot find a way forward. NOT a failure to be hidden:
   *         it is the single most valuable outcome this harness can produce.
   */
  kind: "press" | "wait" | "done" | "stuck";
  n?: number;
  /** In-character reason. One sentence. */
  why: string;
  /** Anything surprising, in character. This is the confusion log. */
  note?: string;
}

const ACTION_SCHEMA: JSONSchema = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "why"],
  properties: {
    kind: { type: "string", enum: ["press", "wait", "done", "stuck"] },
    n: { type: "number", description: "The number of the cell to press. Required when kind is press." },
    why: { type: "string", description: "One sentence, in character, on why you did that." },
    note: {
      type: "string",
      description:
        "Anything confusing or surprising about this screen, in character. Leave out if nothing was.",
    },
  },
};

function personaFor(profile: ChildProfile): string {
  const reads = {
    none: "You cannot read at all. Words on buttons mean nothing to you — you go by the pictures.",
    logographic:
      "You recognise a few familiar words by their shape, but you cannot sound out a new one.",
    emerging: "You can read short words. Long ones are a blur — they show as ▮▮▮.",
    fluent: "You read easily.",
  }[profile.perception.reading];

  const access = {
    touch: "You touch the screen with your finger.",
    eyegaze: "You choose by looking. Aiming is tiring and you sometimes hit the button next to the one you meant.",
    switch: "You use a switch, which is slow.",
  }[profile.access];

  const speech = {
    none: "You cannot speak at all. The board is your only voice.",
    vocalizations: "You make sounds but no words. The board is your only voice.",
    single_words: "You can say one word at a time out loud, but the board says more.",
    fluent: "You can speak, but the board is faster and clearer for you.",
  }[profile.verbalAbility];

  return [
    `You are a ${profile.ageYears}-year-old child using a communication device.`,
    reads,
    access,
    speech,
    `You like ${profile.interests.join(", ")}.`,
    // The receptive dial: the child must not silently understand more than they
    // can. This is the only way `languageLevel` is testable at all.
    `When the device talks to you, you follow ${profile.receptiveLevel.replace(/_/g, " ")} at most. If it says something longer or more complicated than that, say so in your note — you did not follow it.`,
  ].join(" ");
}

const RULES = [
  "You can only press a NUMBER that is printed on the screen you were just shown. Never invent one.",
  "CELL lines are the main board. QUICK lines are the fixed row of controls at the bottom that never changes place. CONTEXT lines are extra words off to the side.",
  'A line reading `—` means the button has NO WORD you can read; you only have its picture.',
  '`(empty)` means there is no button there at all.',
  "HEARD is what the device said out loud to you. SAID is your own voice speaking.",
  "If nothing on the screen lets you say what you mean, look for a button that gets you MORE options, or say you are stuck. Do not pretend a button means something it does not.",
  "Answer as the child. Do not analyse the device, do not mention testing, and do not be a good sport about a screen that does not work.",
].join("\n- ");

export interface ChildTurnInput {
  profile: ChildProfile;
  /** What the child is trying to communicate. Private — never shown to the AAC. */
  intent: string;
  /** The rendered screen — the ONLY thing the child perceives. */
  screen: string[];
  /** Earlier turns, oldest first: what they did and why. Keeps them coherent. */
  history: { action: ChildAction; screen?: string[] }[];
  /** How many presses they have already spent, for their own sense of effort. */
  pressesSoFar: number;
}

export interface ChildTurn {
  action: ChildAction;
  usage: { promptTokens: number; completionTokens: number };
  /**
   * The child model failed to answer usably (truncated, unparseable, empty).
   *
   * MUST NOT be confused with `stuck`. A harness that cannot hear its own child
   * looks identical, in the transcript, to a device that stranded one — and the
   * judge will duly write a damning report about a product bug that never
   * happened. The runner aborts on this instead of scoring it.
   */
  malformed?: boolean;
  /** The unusable payload, for diagnosis. */
  raw?: string;
}

/**
 * Ask the child what they do next.
 *
 * History is passed as a short recap rather than a full transcript: a child does
 * not re-read every screen they have seen, and feeding all of them back would
 * both cost more and make the model reason like an analyst rather than act like
 * a child.
 */
export async function childTurn(input: ChildTurnInput): Promise<ChildTurn> {
  const { profile, intent, screen, history, pressesSoFar } = input;

  const recap = history
    .slice(-6)
    .map((h, i) => `${i + 1}. ${h.action.kind}${h.action.n != null ? ` ${h.action.n}` : ""} — ${h.action.why}`)
    .join("\n");

  const instructions = [
    personaFor(profile),
    "",
    `RIGHT NOW YOU WANT TO SAY: ${intent}`,
    "",
    "How the screen works:",
    `- ${RULES}`,
    "",
    "Reply with one action.",
  ].join("\n");

  

const body = [
    history.length ? `What you have already done:\n${recap}\n` : "",
    pressesSoFar > 0 ? `You have pressed ${pressesSoFar} time(s) so far.\n` : "",
    "THE SCREEN:",
    screen.join("\n"),
  ]
    .filter(Boolean)
    .join("\n");

  const provider = getStructuredProvider("gemini");
  const res = await provider.structuredComplete({
    disclosure: SIM_DISCLOSURE,
    model: CHILD_MODEL,
    instructions,
    input: [{ type: "message", role: "user", content: body }],
    schemaName: "child_action",
    schema: ACTION_SCHEMA,
    // Generous: gemini-2.5-flash spends tokens THINKING before it answers, and
    // a cap that clips the JSON produces an unparseable action that looks like
    // a stuck child. 500 was too low and did exactly that.
    maxTokens: 2000,
    temperature: 1,
  });

  // `content` is the structured payload — a STRING that still needs parsing on
  // this path. Reading `output` instead fails silently and returns nothing.
  const usage = { promptTokens: res.promptTokens ?? 0, completionTokens: res.completionTokens ?? 0 };
  const rawText = typeof res.content === "string" ? res.content : JSON.stringify(res.content ?? null);
  const parsed = typeof res.content === "string" ? safeParse(res.content) : (res.content as ChildAction | null);

  if (!parsed || typeof parsed.kind !== "string") {
    return {
      action: { kind: "stuck", why: "(harness) the child model returned nothing usable" },
      usage,
      malformed: true,
      raw: rawText.slice(0, 800),
    };
  }
  if (parsed.kind === "press" && typeof parsed.n !== "number") {
    return {
      action: { kind: "stuck", why: "(harness) the child pressed without saying what" },
      usage,
      malformed: true,
      raw: rawText.slice(0, 800),
    };
  }
  // `raw` is returned on SUCCESS too: the trace wants the model's exact words,
  // because "why did the child do that?" is answered by what it actually said.
  return { action: parsed, usage, raw: rawText.slice(0, 800) };
}

/** Tolerates the ```json fences some models wrap structured output in. */
function safeParse(s: string): ChildAction | null {
  const cleaned = s.trim().replace(/^```(?:json)?\s*/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned) as ChildAction;
  } catch {
    // Last resort: the first balanced-looking object in the payload.
    const m = cleaned.match(/\{[\s\S]*\}/);
    if (!m) return null;
    try {
      return JSON.parse(m[0]) as ChildAction;
    } catch {
      return null;
    }
  }
}
