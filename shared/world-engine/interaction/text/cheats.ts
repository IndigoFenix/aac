// shared/world-engine/interaction/text/cheats.ts
//
// THE CHEAT CHANNEL — a different object, a different prefix and a different
// file (law ⑦).
//
// `conversationAudit()` / `scopeTree()` / `stockAudit()` / `carryOf()` see
// EVERYTHING: the closure-private conversation book, every place an item could
// be, the merged contents of bags nobody has opened. None of that is visible to
// a player, so none of it may leak into the ordinary narration — which is the
// entire reason this lives behind:
//
//   • a different OBJECT   — `TextSessionDeps.cheatHost`, wired separately from
//                            `host`, so the ordinary command path structurally
//                            cannot reach it;
//   • a different PREFIX   — `/convos`, never a bare word, so a transcript's
//                            command column shows at a glance that a peek
//                            happened;
//   • a different FILE     — this one, so the projection can be read and
//                            reviewed without the omniscient calls in scope;
//   • a different CHANNEL  — the output lands in `TextFrame.cheatLines`, never
//                            in `lines`. Exactly ONE `CHEAT <name>` marker joins
//                            the normal stream, so the transcript records that
//                            the tester looked without recording what they saw.
//
// Named CHEATS, not DEBUG, on purpose: using one invalidates a UX-gap result.
// `help` never mentions the channel — a driver that does not know it exists
// cannot accidentally lean on it.

import { carryRowText } from "../quest/creature-inspect.js";
import type { TextCheatHost } from "./types.js";

/** The commands, without their `/`. `help` must never print this list. */
export const CHEAT_COMMANDS: readonly string[] = ["convos", "scope", "stock", "carry", "probe", "truth", "why"];

/** What the ordinary path says when the channel is off. The flag is named so a
 *  driver can turn it on deliberately, never by accident. */
export const CHEATS_DISABLED = "cheat channel disabled (--cheats).";

export interface CheatCtx {
  /** The omniscient surface. Every method optional — a boot may hand over none. */
  host?: TextCheatHost | undefined;
  /** Latched text id → sim id (`/truth mara`). */
  simIdOf: (textId: string) => string | undefined;
  /** THE RAW RECORD behind a sim id, straight off the probe's state. */
  recordOf: (simId: string) => unknown;
}

export interface CheatResult {
  ok: boolean;
  /** The marker that joins the NORMAL stream — `/convos`, `/carry mara`. */
  marker: string;
  /** The peek itself. Never joins `lines`. */
  lines: string[];
  /** Set when the command could not run; the caller renders it as `ERR`. */
  error?: string;
}

/** A value, printed. Deterministic (JSON key order is insertion order, and every
 *  producer here builds its rows the same way every run) and never throwing —
 *  a cheat that crashes the harness would be worse than one that says nothing. */
export function dump(value: unknown): string[] {
  if (value === undefined || value === null) return ["(nothing)"];
  if (typeof value === "string") return value.split("\n");
  try {
    if (Array.isArray(value)) {
      if (!value.length) return ["(empty)"];
      return value.map((row) => JSON.stringify(row));
    }
    return JSON.stringify(value, null, 2).split("\n");
  } catch {
    return ["(unprintable)"];
  }
}

/** Run one `/…` command. Pure over the ctx: reading can never move the sim. */
export function runCheat(name: string, arg: string | undefined, ctx: CheatCtx): CheatResult {
  const marker = arg ? `/${name} ${arg}` : `/${name}`;
  const host = ctx.host;
  const missing = (what: string): CheatResult => ({
    ok: false,
    marker,
    lines: [],
    error: `this build's cheat host has no ${what}().`,
  });

  switch (name) {
    case "convos":
      if (!host?.conversationAudit) return missing("conversationAudit");
      return { ok: true, marker, lines: dump(host.conversationAudit()) };
    case "scope":
      if (!host?.scopeTree) return missing("scopeTree");
      return { ok: true, marker, lines: dump(host.scopeTree()) };
    case "stock":
      if (!host?.stockAudit) return missing("stockAudit");
      return { ok: true, marker, lines: dump(host.stockAudit()) };
    case "probe":
      if (!host?.debugProbe) return missing("debugProbe");
      return { ok: true, marker, lines: dump(host.debugProbe()) };
    case "carry": {
      if (!arg) return { ok: false, marker, lines: [], error: "/carry needs a creature id." };
      if (!host?.carryOf) return missing("carryOf");
      // A text id resolves to its sim id; anything else goes through verbatim,
      // so a driver who already knows the sim id can name it directly.
      const cid = ctx.simIdOf(arg) ?? arg;
      const carry = host.carryOf(cid);
      // ⚖️ THE HANDS LINE FIRST — `carryOf` merges bag CONTENTS and never the
      // bag, so this dump alone reported an empty basket as nothing at all.
      // Same renderer as the creature readout, so the two cannot drift apart.
      const hands = host.handsOf?.(cid) ?? undefined;
      return {
        ok: true,
        marker,
        lines: [
          `${arg} = ${cid}`,
          `hands = ${carryRowText(hands, carry as Record<string, number> | undefined)}`,
          ...dump(carry),
        ],
      };
    }
    case "why": {
      // ⚖️ WHY-CHAINS §4 — the raw ladder behind "why are you doing that?",
      // dumped. A cheat and not an ordinary command because it reads the chain
      // of a body nobody is standing in front of, which no player can see.
      if (!arg) return { ok: false, marker, lines: [], error: "/why needs a creature id." };
      if (!host?.whyProbe) return missing("whyProbe");
      const cid = ctx.simIdOf(arg) ?? arg;
      return { ok: true, marker, lines: [`${arg} = ${cid}`, ...dump(host.whyProbe(cid))] };
    }
    case "truth": {
      if (!arg) return { ok: false, marker, lines: [], error: "/truth needs a text id." };
      const simId = ctx.simIdOf(arg);
      if (!simId) return { ok: false, marker, lines: [], error: `no text id "${arg}" is latched.` };
      // THE ONE CHEAT THAT NEEDS NO HOST: the sim id behind a text id, and the
      // raw record the projection worded — the answer to "what did text mode
      // actually see when it said that?".
      return { ok: true, marker, lines: [`${arg} = ${simId}`, ...dump(ctx.recordOf(simId))] };
    }
    default:
      return {
        ok: false,
        marker,
        lines: [],
        error: `unknown cheat "/${name}". Known: ${CHEAT_COMMANDS.map((c) => `/${c}`).join(" ")}.`,
      };
  }
}
