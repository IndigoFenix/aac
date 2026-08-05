// shared/world-engine/interaction/text/parse.ts
//
// COMMAND STRING → `TextCommand`. Pure, locale-free, and deliberately forgiving
// about SHAPE while strict about VOCABULARY: an AI driver mistyping a command
// must get an `ERR` naming the closed command set, never a silent no-op.
//
// Phase 1 (design §8 step ④) covers: look / scene / self / board / say / press /
// more / back / wait / help.
// TODO step ⑧: `build …` (builder driving, press/screen accounting).
// TODO step ⑨: `go` / `approach` / `stop`.
// TODO step ⑩: `watch` / `unwatch`.
// TODO step ⑪: the `/`-prefixed cheat channel (a DIFFERENT prefix, law ⑦) —
//   this parser must keep rejecting `/…` until that step lands.

import type { TextParseResult } from "./types.js";
import { WAIT_DEFAULT_S } from "./types.js";

/** The phase-1 command words, in the order `help` lists them. */
export const TEXT_COMMANDS: readonly string[] = [
  "look",
  "scene",
  "self",
  "board",
  "say",
  "press",
  "more",
  "back",
  "wait",
  "help",
];

/** `look chair 2` → `chair-2`: a trailing bare ordinal is part of the text id
 *  (§4 "accepted shorthand"), so the driver may type it either way. */
export function joinTarget(words: readonly string[]): string {
  const parts = words.filter((w) => w.length > 0);
  if (parts.length >= 2 && /^\d+$/.test(parts[parts.length - 1]!)) {
    return `${parts.slice(0, -1).join("-")}-${parts[parts.length - 1]}`;
  }
  return parts.join("-");
}

/**
 * Parse one line of driver input. Returns a `TextCommand`, or `{ error }` when
 * the line is not one — the caller renders that as `ERR`.
 */
export function parseCommand(input: string): TextParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { error: "empty command. Type help for the command list." };
  if (trimmed.startsWith("/")) {
    // Law ⑦: the cheat channel is a different prefix AND a different file, and
    // it is deliberately the LAST thing built (step ⑪).
    return { error: "cheat commands are not available in this build." };
  }

  const parts = trimmed.split(/\s+/);
  const verb = parts[0]!.toLowerCase();
  const rest = parts.slice(1);

  switch (verb) {
    case "look": {
      if (!rest.length) return { kind: "look" };
      return { kind: "look", target: joinTarget(rest.map((w) => w.toLowerCase())) };
    }
    case "scene":
      return { kind: "scene" };
    case "self":
      return { kind: "self" };
    case "board":
      return { kind: "board" };
    case "say": {
      // The words are the driver's own composition; `+` is optional sugar so a
      // pasted glyph sentence ("want + apple") parses identically to "want apple".
      const words = rest
        .join(" ")
        .split("+")
        .flatMap((chunk) => chunk.trim().split(/\s+/))
        .filter((w) => w.length > 0);
      if (!words.length) return { error: "say what? e.g. say want + apple" };
      return { kind: "say", words };
    }
    case "press": {
      if (!rest.length) return { error: "press what? a number, or a button's label." };
      const first = rest[0]!;
      if (/^\d+$/.test(first) && rest.length === 1) return { kind: "press", index: Number(first) };
      return { kind: "press", label: rest.join(" ") };
    }
    case "more":
      return { kind: "more" };
    case "back":
      return { kind: "back" };
    case "wait": {
      if (!rest.length) return { kind: "wait", seconds: WAIT_DEFAULT_S };
      const n = Number(rest[0]);
      if (!Number.isFinite(n) || n <= 0) return { error: `wait needs a positive number of seconds.` };
      return { kind: "wait", seconds: n };
    }
    case "help":
      return { kind: "help" };
    default:
      return { error: `unknown command "${verb}". Known: ${TEXT_COMMANDS.join(", ")}.` };
  }
}
