// shared/world-engine/interaction/text/render.ts
//
// EVENTS → LINES. A pure formatter and nothing else (§2): no state, no clock, no
// locale decisions (payloads arrive already localized), no I/O. Same events in,
// byte-identical lines out — which is what makes a transcript diffable and the
// golden tests meaningful.
//
// The grammar, rigid so diffs align:
//   col 0  TAG      1–6 uppercase ASCII, padded to 6, then ONE space
//   col 7  payload  one fact, one line
//   col 0  "  "     continuation lines begin with two spaces
//   col 0  ">"      an echoed command (renderEcho)
//   col 0  "#"      a header/footer comment (renderComment)
// Blank lines are NEVER emitted.

import { TAG_WIDTH, type SceneEntry, type TextBoardOption, type TextEvent } from "./types.js";

/** `TAG` + padding + one space — the payload column. */
function head(tag: string, payload: string): string {
  return `${tag.padEnd(TAG_WIDTH)} ${payload}`;
}

/** A continuation line: two spaces, then the fact. */
function cont(payload: string): string {
  return `  ${payload}`;
}

/** An echoed command — the transcript is its own replay script. */
export function renderEcho(input: string): string {
  return `> ${input}`;
}

/** A header/footer comment (above/below the diff fence). */
export function renderComment(text: string): string {
  return `# ${text}`;
}

/** A number with one decimal, always (`1.4`, `3.0`) — no locale separators. */
function secs(n: number): string {
  return (Math.round(n * 10) / 10).toFixed(1);
}

/** `"text"  [glyph]` — the glyph rides beside the words, never instead of them. */
function said(text: string, glyph?: string): string {
  const words = text ? `"${text}"` : "";
  const sym = glyph ? `[${glyph}]` : "";
  return words && sym ? `${words}  ${sym}` : words || sym;
}

/** `mara: "…"` / `"…"` when the line could not be attributed to a body. */
function attributed(who: string | null, body: string): string {
  return who ? `${who}: ${body}` : body;
}

/** One board / builder button, numbered including chrome (law ④). */
function optionLine(o: TextBoardOption): string {
  const parts = [`${o.n}. ${o.label}`];
  if (o.glyph) parts.push(`[${o.glyph}]`);
  // §7: the spoken text is quoted ONLY when it differs from the caption.
  if (o.spokenText && o.spokenText !== o.label) parts.push(`"${o.spokenText}"`);
  // A MODIFIER IS NOT A WORD: it composes onto the head with a "." instead of
  // taking a slot of its own, and a driver counting presses needs to see which
  // rows are which.
  if (o.modifier) parts.push("(modifier)");
  return parts.join("  ");
}

/**
 * The SUBJECT of a scene row. A bucket of one is not an inventory row: "1 chair"
 * reads as a spreadsheet cell, "a chair" reads as a thing in a room (design D5,
 * "a townsperson stands"). The article comes from the caller — it is grammar,
 * and this formatter knows no language.
 */
function bucketSubject(e: SceneEntry): string {
  const count = e.count ?? 0;
  if (count === 1) return e.article ? `${e.article} ${e.word}` : e.word;
  // `collapsed` is the remainder of a kind, folded across every band — it reads
  // as the rest of the skyline rather than as another countable group.
  return e.collapsed ? `${count} more ${e.word}` : `${count} ${e.word}`;
}

/** One SCENE row: a named individual, a crowd bucket, a landmark, or skyline. */
function sceneLine(e: SceneEntry): string {
  const subject =
    e.kind === "group" || e.kind === "place-group"
      ? bucketSubject(e)
      : e.textId
        ? `${e.textId} (${e.word})`
        : e.word;
  const where =
    e.kind === "place-group" && e.collapsed
      ? "ring the town" // folded across every band — no one direction is true
      : `${e.band} ${e.cardinal}`;
  const parts = [`${subject}, ${where}`];
  if (e.activity) parts.push(e.activity);
  for (const d of e.detail ?? []) parts.push(d);
  return `${parts.join(", ")}.`;
}

/**
 * Render ONE event to its line(s). Exported so a driver can format incrementally
 * (a REPL streaming as the settle runs) without re-rendering the whole frame.
 */
export function renderEvent(ev: TextEvent): string[] {
  switch (ev.tag) {
    case "SAY":
      return [head("SAY", attributed(ev.who, said(ev.text, ev.glyph)))];
    case "SILENT": {
      // Law ③: silence is an EVENT. The bubble's own marker ("…") is copied
      // through, but UNQUOTED — quotation marks mean "said aloud", and the whole
      // point of a thought bubble is that nothing was.
      const body = [ev.text || "…", ev.glyph ? `[${ev.glyph}]` : ""].filter(Boolean).join("  ");
      return [head("SILENT", attributed(ev.who, body))];
    }
    case "TURN":
      return [head("TURN", `${ev.who} turned ${ev.away ? "away from" : "toward"} you.`)];
    case "ENTER":
      return [head("ENTER", ev.where ? `${ev.who} came into view ${ev.where}.` : `${ev.who} came into view.`)];
    case "EXIT":
      // THE VISIBLE TRANSIT wins when there is one: "Mara went into the blue
      // house" is what a sighted player saw; "left view south" is what is left
      // to say when they simply walked out of range.
      if (ev.via) return [head("EXIT", `${ev.who} went ${ev.via}.`)];
      return [head("EXIT", ev.where ? `${ev.who} left view ${ev.where}.` : `${ev.who} left view.`)];
    case "DOING":
      return [head("DOING", `${ev.who} is ${ev.activity}.`)];
    case "MOVED":
      return [head("MOVED", `${ev.who} is now ${ev.band} ${ev.cardinal}.`)];
    case "HOLD":
      return [head("HOLD", ev.what ? `${ev.who} is holding ${ev.what}.` : `${ev.who} is holding nothing.`)];
    case "WEAR":
      return [head("WEAR", `${ev.who} is wearing ${ev.what}.`)];
    case "OPEN":
      return [head("OPEN", `${ev.what} is ${ev.open ? "open" : "shut"}.`)];
    case "STOCK":
      return [
        head("STOCK", ev.items.length ? `${ev.what} holds ${ev.items.join(", ")}.` : `${ev.what} is empty.`),
      ];
    case "TOAST":
      return [head("TOAST", ev.kind ? `${ev.text} (${ev.kind})` : ev.text)];
    case "GOAL":
      return [head("GOAL", ev.locked ? `${ev.text} (locked)` : ev.text)];
    case "WON":
      return [head("WON", "the game is won.")];
    case "POCKET": {
      if (!ev.items.length) return [head("POCKET", "empty.")];
      const lines = [head("POCKET", `${ev.items.length} stack(s).`)];
      for (const it of ev.items) {
        lines.push(cont(`${it.label} [${it.glyph}] ×${it.count}${it.selected ? " (armed)" : ""}`));
      }
      return lines;
    }
    case "BOARD": {
      const prompt = ev.prompt ? `${ev.promptText}  [${ev.prompt}]` : ev.promptText;
      const lines = [head("BOARD", `${ev.posedBy}: ${prompt}`)];
      for (const o of ev.options) lines.push(cont(optionLine(o)));
      return lines;
    }
    case "CLOSE":
      return [head("CLOSE", "the board closed.")];
    case "TICK":
      switch (ev.reason) {
        case "waited":
          return [head("TICK", `waited ${secs(ev.seconds)}s.`)];
        case "capped":
          return [head("TICK", `still busy after ${secs(ev.seconds)}s.`)];
        case "arrived":
          return [head("TICK", `arrived after ${secs(ev.seconds)}s.`)];
        case "walking":
          return [head("TICK", `still walking — ${Math.round(ev.metres ?? 0)} m to go.`)];
        default:
          return [head("TICK", `quiet after ${secs(ev.seconds)}s.`)];
      }
    case "SCENE": {
      // Two counts, never one. The header must not claim "95 in view" over eight
      // printed lines — things and places are summarized by different rules, so
      // they are counted separately and both are true.
      const things = ev.count ? `${ev.count} thing(s) in view` : "nothing in view";
      const where = ev.places ? `${things}, ${ev.places} place(s) around you` : things;
      const lines = [head("SCENE", `${ev.place} — ${where}.`)];
      for (const e of ev.entries) lines.push(cont(sceneLine(e)));
      return lines;
    }
    case "LOOK": {
      const lines = [head("LOOK", `${ev.textId} — ${ev.word}.`)];
      for (const f of ev.facts) lines.push(cont(f));
      return lines;
    }
    case "SPOT": {
      // The lit ground, one line each — a wash a text driver can aim at. The
      // focused one is marked because in GL it is the BRIGHT one, and which
      // spot is settled on is what the build board is about.
      if (!ev.entries.length) return [head("SPOT", "no ground is lit — the build word is not up.")];
      const lines = [head("SPOT", `${ev.entries.length} place(s) lit.`)];
      for (const e of ev.entries) {
        const offers = e.offers?.length ? ` — could take: ${e.offers.join(", ")}` : "";
        lines.push(
          cont(
            `${e.textId} (${e.what}), ${e.band} ${e.cardinal}, ${Math.round(e.distance)} m` +
              `${offers}${e.focused ? " ← your gaze rests here" : ""}`,
          ),
        );
      }
      return lines;
    }
    case "FAMILY": {
      if (!ev.entries.length) return [head("FAMILY", "no household here.")];
      const lines = [head("FAMILY", `${ev.entries.length} in the household.`)];
      for (const e of ev.entries) {
        const marks = [e.present ? "" : "away", e.addressed ? "ADDRESSED" : ""].filter(Boolean);
        lines.push(cont(`${e.textId} (${e.label}) — ${e.state}${marks.length ? ` [${marks.join(", ")}]` : ""}`));
      }
      return lines;
    }
    case "SITE": {
      if (!ev.entries.length) return [head("SITE", "nothing is being built.")];
      const STAGE = ["marked ground", "floor laid", "pillars up"] as const;
      const lines = [head("SITE", `${ev.entries.length} thing(s) being built.`)];
      for (const e of ev.entries) {
        const pct = e.progress !== undefined ? `, ${Math.round(e.progress * 100)}% worked` : "";
        lines.push(
          cont(
            `${e.textId}: a ${e.word} — ${STAGE[e.stage]}${pct}, ${e.band} ${e.cardinal}, ${Math.round(e.distance)} m`,
          ),
        );
      }
      return lines;
    }
    case "SELF": {
      const lines = [head("SELF", ev.where)];
      for (const f of ev.facts) lines.push(cont(f));
      return lines;
    }
    case "WHERE":
      return [head("WHERE", `${ev.textId} is ${ev.band} ${ev.cardinal}, ${Math.round(ev.distance)} m away.`)];
    case "WHO":
      return [head("WHO", ev.members.length ? ev.members.join(", ") + "." : "nobody is talking.")];
    case "WATCH":
      if ("list" in ev) {
        return [head("WATCH", ev.list.length ? `watching ${ev.list.join(", ")}.` : "watching nobody.")];
      }
      return [head("WATCH", `${ev.on ? "watching" : "no longer watching"} ${ev.textId}.`)];
    case "BUILDER": {
      // THE HEADER IS THE COMPOSITION AND ITS PREVIEW: what has been pressed,
      // what it would SAY (translated, never re-composed), and whether the
      // surfacer already considers it sayable.
      const so = ev.partial ? `so far: ${ev.partial}` : "so far: (nothing)";
      const said = ev.preview ? `  "${ev.preview}"` : "";
      const done = ev.complete ? "  (complete)" : "";
      const lines = [head("BUILDER", `${so}${said}${done}`)];
      for (const o of ev.options) lines.push(cont(optionLine(o)));
      if (ev.groups?.length) {
        lines.push(cont(`groups: ${ev.groups.map((g) => `${g.id} (${g.count})`).join(", ")}`));
      }
      if (ev.tabs?.length) lines.push(cont(`tabs: ${ev.tabs.join(", ")}`));
      // Law ④: WHERE IN THE LIST YOU ARE is part of the cost. A word on page 3
      // of a tab is three screens away, and the block has to say so.
      if (ev.pages !== undefined && ev.pages > 1) {
        lines.push(cont(`page ${ev.page ?? 1}/${ev.pages} — more / back`));
      }
      return lines;
    }
    case "HELP": {
      const lines = [head("HELP", "commands:")];
      for (const c of ev.commands) lines.push(cont(c));
      return lines;
    }
    case "OK":
      return [head("OK", ev.text)];
    case "ERR":
      return [head("ERR", ev.text)];
    case "ASK": {
      const lines = [head("ASK", ev.question)];
      for (const o of ev.options) lines.push(cont(o));
      return lines;
    }
    case "NOTE":
      return [head("NOTE", ev.text)];
    case "CHEAT":
      return [head("CHEAT", ev.text)];
  }
}

/** Render a whole frame. Blank lines are dropped — the grammar forbids them. */
export function renderEvents(events: readonly TextEvent[]): string[] {
  const out: string[] = [];
  for (const ev of events) {
    for (const line of renderEvent(ev)) {
      if (line.trim()) out.push(line);
    }
  }
  return out;
}

/** Convenience: the frame as ONE string (transcript / REPL write). */
export function renderFrame(events: readonly TextEvent[], echo?: string): string {
  const lines = echo === undefined ? [] : [renderEcho(echo)];
  lines.push(...renderEvents(events));
  return lines.join("\n");
}
