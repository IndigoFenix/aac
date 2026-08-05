// shared/world-engine/interaction/text/parse.ts
//
// COMMAND STRING → `TextCommand`. Pure, locale-free, and deliberately forgiving
// about SHAPE while strict about VOCABULARY: an AI driver mistyping a command
// must get an `ERR` naming the closed command set, never a silent no-op.
//
// The full set (design §8, steps ④–⑪):
//   look scene self board say press more back wait help          (④)
//   builder build …                                              (⑧)
//   go approach stop send where who                              (⑨)
//   watch unwatch watching                                       (⑩)
//   /convos /scope /stock /carry /probe /truth                   (⑪)
//
// THE CHEAT PREFIX IS PARSED HERE BUT GATED ELSEWHERE (law ⑦). This layer only
// recognizes the shape; whether the channel is open at all is the session's
// question, and the answer defaults to no.

import type { TextParseResult } from "./types.js";
import { WAIT_DEFAULT_S } from "./types.js";

/** The command words, in the order `help` lists them. The cheat channel is NOT
 *  here, and must never be: `help` is what an AI driver reads to learn the
 *  harness, and a tester who never hears of the channel cannot lean on it. */
export const TEXT_COMMANDS: readonly string[] = [
  "look",
  "scene",
  "self",
  "board",
  "spots",
  "family",
  "say",
  "press",
  "more",
  "back",
  "builder",
  "build",
  "go",
  "approach",
  "stop",
  "send",
  "where",
  "who",
  "watch",
  "unwatch",
  "watching",
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

const target = (rest: readonly string[]): string => joinTarget(rest.map((w) => w.toLowerCase()));

/** `build …` — one verb, six operations (builder.ts holds the state). */
function parseBuild(rest: readonly string[]): TextParseResult {
  if (!rest.length) return { kind: "build", op: "show" };
  const head = rest[0]!.toLowerCase();
  const tail = rest.slice(1).join(" ").trim();
  switch (head) {
    case "tab":
      if (!tail) return { error: "build tab what? e.g. build tab things" };
      return { kind: "build", op: "tab", arg: tail };
    case "group":
      if (!tail) return { error: "build group what? e.g. build group food" };
      return { kind: "build", op: "group", arg: tail };
    case "undo":
      return { kind: "build", op: "undo" };
    case "clear":
      return { kind: "build", op: "clear" };
    case "play":
      return { kind: "build", op: "play" };
    default:
      // Everything else is a WORD TAP: a caption, a key, a number, or — with a
      // leading "." — the modifier rail composing onto the current head.
      return { kind: "build", op: "word", arg: rest.join(" ").trim() };
  }
}

/**
 * Parse one line of driver input. Returns a `TextCommand`, or `{ error }` when
 * the line is not one — the caller renders that as `ERR`.
 */
export function parseCommand(input: string): TextParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { error: "empty command. Type help for the command list." };

  // Law ⑦: the cheat channel is a DIFFERENT PREFIX. Recognized here, gated in
  // the session — a build without `--cheats` answers with the closed door.
  if (trimmed.startsWith("/")) {
    const parts = trimmed.slice(1).split(/\s+/).filter((w) => w.length > 0);
    const name = (parts[0] ?? "").toLowerCase();
    if (!name) return { error: "cheat commands look like /convos or /truth <id>." };
    const rest = parts.slice(1).join(" ");
    return { kind: "cheat", name, ...(rest ? { arg: rest } : {}) };
  }

  const parts = trimmed.split(/\s+/);
  const verb = parts[0]!.toLowerCase();
  const rest = parts.slice(1);

  switch (verb) {
    case "look": {
      if (!rest.length) return { kind: "look" };
      return { kind: "look", target: target(rest) };
    }
    case "scene":
      return { kind: "scene" };
    case "self":
      return { kind: "self" };
    case "board":
      return { kind: "board" };
    case "spots":
      return { kind: "spots" };
    case "family": {
      const who = rest.join(" ").trim();
      return { kind: "family", ...(who ? { who } : {}) };
    }
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
    case "builder":
      return { kind: "builder" };
    case "build":
      return parseBuild(rest);
    case "go": {
      if (!rest.length) return { error: "go where? name something in view." };
      return { kind: "go", target: target(rest) };
    }
    case "approach": {
      if (!rest.length) return { error: "approach whom? name somebody in view." };
      return { kind: "go", target: target(rest), approach: true };
    }
    case "stop":
      return { kind: "stop" };
    case "send": {
      // `send <creature> to <id>` — the "to" is required, because "send mara
      // bram" is genuinely ambiguous about which of them goes.
      const at = rest.findIndex((w) => w.toLowerCase() === "to");
      if (at <= 0 || at === rest.length - 1) {
        return { error: "send whom where? e.g. send mara to chair-2" };
      }
      return { kind: "send", creature: target(rest.slice(0, at)), target: target(rest.slice(at + 1)) };
    }
    case "where": {
      if (!rest.length) return { error: "where is what? name something you have seen." };
      return { kind: "where", target: target(rest) };
    }
    case "who":
      return { kind: "who" };
    case "watch": {
      if (!rest.length) return { error: "watch what? name something in view." };
      return { kind: "watch", target: target(rest) };
    }
    case "unwatch": {
      if (!rest.length) return { error: "unwatch what? name one, or all." };
      if (rest.length === 1 && rest[0]!.toLowerCase() === "all") return { kind: "unwatch", target: "all" };
      return { kind: "unwatch", target: target(rest) };
    }
    case "watching":
      return { kind: "watching" };
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
