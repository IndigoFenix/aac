// server/services/dual-agent/guessing-seeder.ts
//
// On guessing_enter from a normal conversation, run a fast LLM
// classifier that turns "what was the AI just talking about?" into a
// starting category for the narrowing engine. When the conversation
// already established a clear topic ("we've been chatting about
// animals") we can skip the "what kind of thing are you looking for?"
// turn entirely and pre-press the engine into the right category — so
// the very first Word Finder board shows useful narrowing options
// instead of a generic category menu.
//
// The classifier returns one of three shapes:
//   - { kind: "predefined", category }  → applyGuessingPress(category)
//   - { kind: "new", label }            → applyCustomFact("topic", label)
//   - { kind: "unknown" }               → leave the engine as-is (top-level)
//
// Why a tool-call instead of a JSON response: Gemini's chat path here
// doesn't currently surface a responseSchema field, but tool-calling
// gives us the same structured-output guarantee (enum-constrained
// argument) without touching the provider abstraction. Single tool,
// toolChoice: "required" — the model's only valid output is the call.

import { getChatProvider } from "../providers/provider-factory";
import type { ChatTool } from "../providers/streaming-provider";
import { GUESSING_CATEGORIES, type GuessingCategory } from "@shared/guessing-mode/types";

/**
 * Parse the student's interests from monitor memory (`Student_Interests`) into
 * a clean list. Mirrors the parser in `monitor-agent.ts` — accepts an array or
 * a comma/semicolon/newline-delimited string. Used to seed the guessing
 * engine's `specialInterests` so the first board + the AI's guesses reflect
 * what the student actually cares about.
 */
export function parseInterestsList(raw: unknown): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  if (typeof raw === "string") return raw.split(/[,;\n]/).map((s) => s.trim()).filter(Boolean);
  return [];
}

/** Whole-year age from an ISO birthDate, or undefined if missing/unparseable.
 *  Mirrors the age formula in `monitor-agent.ts`. Seeds the guessing engine so
 *  the AI keeps its guesses age-appropriate (an adult isn't led with "toy"). */
export function computeAgeYears(birthDate: unknown): number | undefined {
  if (!birthDate || (typeof birthDate !== "string" && !(birthDate instanceof Date))) return undefined;
  const t = new Date(birthDate as string | Date).getTime();
  if (!Number.isFinite(t)) return undefined;
  const age = Math.floor((Date.now() - t) / (365.25 * 24 * 60 * 60 * 1000));
  return age >= 0 && age < 150 ? age : undefined;
}

// Gemini Flash is fast enough that the round-trip is on the order of
// the few hundred milliseconds the user wouldn't notice between
// "tapped the Word Finder button" and "first narrowing board appears."
const SEEDER_MODEL = "gemini-2.5-flash";
const SEEDER_PROVIDER = "gemini" as const;

export type GuessingSeedResult =
  | { kind: "predefined"; category: GuessingCategory }
  | { kind: "new"; label: string }
  | { kind: "unknown" };

const TOOL: ChatTool = {
  type: "function",
  function: {
    name: "report_category",
    description:
      "Report the category of word the user is most likely trying to find, based on the AI's most recent question.",
    parameters: {
      type: "object",
      properties: {
        category: {
          type: "string",
          enum: [...GUESSING_CATEGORIES, "unknown", "new"],
          description:
            "Pick the predefined category that obviously fits the conversation. Use 'new' when there is a clear topic but it doesn't match any predefined category (you must then provide new_category_label). Use 'unknown' when the conversation gives you nothing to lean on.",
        },
        new_category_label: {
          type: "string",
          description:
            "Required ONLY when category='new'. A short human-readable noun phrase for the topic (one or two words). Examples: 'movies', 'songs', 'school subjects', 'colors'.",
        },
      },
      required: ["category"],
    },
  },
};

const SYSTEM_PROMPT = `You classify what kind of word an AAC user is trying to find. They have just opened a word-finder assistant. The AI's most recent question gives strong context for what category fits.

Predefined categories and what they cover:
- things   — physical objects, food, animals, toys, body parts
- actions  — verbs and activities (running, eating, sleeping, playing)
- people   — family, friends, classmates, public figures
- places   — locations, rooms, settings (home, school, beach, the park)
- feelings — emotions and physical sensations (happy, tired, hungry, scared)
- time     — time periods and events (yesterday, birthday, morning, summer)

Pick the SINGLE best fit. If none of the six clearly fit but the topic is still identifiable (e.g. movies, music, school subjects), pick "new" and supply a short label. If you genuinely cannot tell what they're looking for, pick "unknown".`;

/**
 * Classify the recent conversation into one of the guessing categories.
 * Returns null on transport / parse failure — callers should fall back
 * to the engine's default (no category seeded, top-level menu shown).
 */
export async function seedGuessingFromConversation(input: {
  lastAIQuestion: string;
  signal?: AbortSignal;
}): Promise<GuessingSeedResult | null> {
  const question = input.lastAIQuestion.trim();
  if (!question) return null;

  let result;
  try {
    const provider = getChatProvider(SEEDER_PROVIDER);
    result = await provider.completeChat({
      model: SEEDER_MODEL,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: `Recent AI question to the user: "${question}"\n\nWhat category of word are they trying to find?`,
        },
      ],
      tools: [TOOL],
      toolChoice: "required",
      temperature: 0.1,
      maxTokens: 60,
      signal: input.signal,
    });
  } catch (err: any) {
    console.warn(`[guessing-seeder] LLM call failed: ${err?.message ?? err}`);
    return null;
  }

  const call = result.toolCalls?.[0];
  if (!call || call.name !== "report_category") return null;

  let args: any;
  try {
    args = JSON.parse(call.arguments);
  } catch {
    return null;
  }

  const category = String(args?.category ?? "").trim();
  if ((GUESSING_CATEGORIES as readonly string[]).includes(category)) {
    return { kind: "predefined", category: category as GuessingCategory };
  }
  if (category === "new") {
    const label = String(args?.new_category_label ?? "").trim();
    // A "new" verdict without a label is useless to the engine — fall
    // back to "unknown" so the AI shows the top-level category menu.
    if (!label) return { kind: "unknown" };
    return { kind: "new", label };
  }
  return { kind: "unknown" };
}
