/**
 * Can the AAC actually REACH the picture search?
 *
 * These tests exist because the feature shipped once already and did nothing.
 * The registry entry, the tool and the app all worked — but the DEFAULT session
 * is live native audio with the Speaker's tools SUPPRESSED, and in that shape:
 *
 *   - the Speaker gets `<activities>`, a bare list of app NAMES, so it never
 *     learned picture search was real and kept promising pictures it could not
 *     produce ("let's find a picture of an owl" → nothing);
 *   - the Board Manager is the only agent that can open anything, and its
 *     launch buttons could not carry a query, so even a correct button would
 *     have opened the search on nothing.
 *
 * So: a capability is not shipped until the agent that can actually fire it
 * both knows it exists and can pass it an argument. That is what is asserted
 * here — the prompt text and the tool schema, in BOTH Speaker shapes.
 */

import { describe, test, expect } from "@jest/globals";
import { buildSpeakerPrompt, buildSpeakerToolDeclarations } from "../services/dual-agent/prompts/speaker.js";
import {
  buildBoardManagerPrompt,
  buildBoardManagerToolDeclarations,
} from "../services/dual-agent/prompts/board-manager.js";
import { PICTURE_SEARCH_APP_ID } from "../../shared/picture-search.js";
import { getAppDefinition } from "../services/dual-agent/app-registry.js";

const PICTURE_SEARCH = {
  id: PICTURE_SEARCH_APP_ID,
  name: "Find a Picture",
  description: getAppDefinition(PICTURE_SEARCH_APP_ID)!.description,
  queryHint: getAppDefinition(PICTURE_SEARCH_APP_ID)!.queryHint!,
};
const DRAWING = { id: "drawing", name: "Drawing", description: "A canvas." };

const base = {
  studentName: "Alex",
  persona: "",
  muteState: "unmuted" as const,
  useDirectAudio: false,
};

// ── Speaker, live native audio (the DEFAULT — tools suppressed) ─────────────

describe("Speaker <apps> — the shape that was broken", () => {
  const liveAudio = { ...base, liveAudio: true };

  test("says picture search is REAL and that the Speaker opens it ITSELF", () => {
    const prompt = buildSpeakerPrompt({ ...liveAudio, enabledApps: [DRAWING, PICTURE_SEARCH] });

    expect(prompt).toContain("<apps>");
    // The bare name was all it used to get, and a name is not a capability.
    expect(prompt).toContain("Find a Picture");
    // The capability is stated by the registry description; the row note is
    // the brake on it (Daniel hand-tuned that wording 2026-08-20 — do not
    // re-assert my phrasing over it).
    expect(prompt).toContain("the ONLY way you can find a picture of something");
    expect(prompt).toContain("Use this ONLY if the user requests pictures specifically");
    // 2026-08-19 (Daniel): the live Speaker carries open_app as its ONE tool —
    // it opens the app itself instead of relaying through the Board Manager.
    expect(prompt).toContain('open_app("picture_search"');
    expect(prompt).toContain("Never promise an app without calling open_app");
    // And it must not describe pictures it cannot see.
    expect(prompt).toContain("do not describe one until you are told");
  });

  test("live native-audio declares open_app + close_app — nothing else", () => {
    // The tool surface is suppressed in live audio to dodge MALFORMED bursts.
    // Two exceptions, both about the SCREEN rather than the conversation: a
    // silent open beats a promised-but-never-opened app, and close_app takes no
    // arguments at all, so there is nothing in it to malform.
    const tools = buildSpeakerToolDeclarations({
      useDirectAudio: true,
      isMutedMode: false,
      enabledApps: [
        { id: "picture_search", name: "Find a Picture", queryHint: "what to find — REQUIRED" },
      ],
    } as any);
    const decls = (tools[0]?.functionDeclarations ?? []).map((d: any) => d.name);
    expect(decls).toEqual(["open_app", "close_app"]);
    // ...and with no apps at all, the surface stays empty.
    expect(
      buildSpeakerToolDeclarations({ useDirectAudio: true, isMutedMode: false, enabledApps: [] } as any),
    ).toEqual([]);
  });

  test("the open_app data hint names the query apps", () => {
    const tools = buildSpeakerToolDeclarations({
      useDirectAudio: true,
      isMutedMode: false,
      enabledApps: [
        { id: "drawing", name: "Drawing" },
        { id: "picture_search", name: "Find a Picture", queryHint: "what to find — REQUIRED" },
      ],
    } as any);
    const openApp = tools[0].functionDeclarations!.find((d: any) => d.name === "open_app")!;
    const params = openApp.parametersJsonSchema as any;
    expect(params.properties.data.description).toContain("picture_search");
  });

  test("does NOT claim the capability when the app is off", () => {
    const prompt = buildSpeakerPrompt({ ...liveAudio, enabledApps: [DRAWING] });
    expect(prompt).not.toContain("You CAN show real pictures");
    expect(prompt).toContain("You CANNOT search the internet for pictures");
  });

  test("the denial is absent when the app IS on — never both", () => {
    // The original bug was the worst of both: no tool, and no denial either.
    const prompt = buildSpeakerPrompt({ ...liveAudio, enabledApps: [PICTURE_SEARCH] });
    expect(prompt).not.toContain("You CANNOT search the internet for pictures");
  });
});

// ── Speaker, tool mode ──────────────────────────────────────────────────────

describe("Speaker <apps> — tool mode", () => {
  const toolMode = { ...base, liveAudio: false };

  test("carries the registry description, which says how to call it", () => {
    const prompt = buildSpeakerPrompt({ ...toolMode, enabledApps: [PICTURE_SEARCH] });
    expect(prompt).toContain("<apps>");
    expect(prompt).toContain(PICTURE_SEARCH_APP_ID);
    expect(prompt).toContain('open_app("picture_search"');
  });

  test("denies the capability when off, in this shape too", () => {
    const prompt = buildSpeakerPrompt({ ...toolMode, enabledApps: [DRAWING] });
    expect(prompt).toContain("You CANNOT search the internet for pictures");
  });
});

// ── Board Manager — the only agent that can actually open it ────────────────

function bmTools(apps: Array<{ id: string; name: string; queryHint?: string }>) {
  return buildBoardManagerToolDeclarations({
    availableBoards: [],
    enabledApps: apps,
    maxBoardItems: 8,
  } as any);
}

/** Pull the `open` sub-schema off rebuild_board's button items. */
function openSchema(apps: Array<{ id: string; name: string; queryHint?: string }>): any {
  const tools = bmTools(apps);
  const decls = (tools as any[]).flatMap((t) => t.functionDeclarations ?? [t]);
  const rebuild = decls.find((d: any) => d.name === "rebuild_board");
  return rebuild?.parametersJsonSchema?.properties?.buttons?.items?.properties?.open;
}

describe("Board Manager launch buttons", () => {
  test("expose appQuery when an enabled app takes one", () => {
    const open = openSchema([DRAWING, PICTURE_SEARCH]);
    expect(open).toBeDefined();
    expect(open.properties.app).toBeDefined();
    expect(open.properties.appQuery).toBeDefined();
    // The hint must name the app it belongs to, so the model can tell which of
    // several query-taking apps it is filling in.
    expect(open.properties.appQuery.description).toContain(PICTURE_SEARCH_APP_ID);
  });

  test("omit appQuery entirely when no enabled app takes one", () => {
    const open = openSchema([DRAWING]);
    expect(open.properties.app).toBeDefined();
    expect(open.properties.appQuery).toBeUndefined();
  });

  test("the BM no longer claims the direct open — the Speaker owns it", () => {
    // 2026-08-19 (Daniel): open_app moved to the live Speaker. The BM's job is
    // the OFFER button, and it is told explicitly not to duplicate an open the
    // DEVICE just announced — two agents opening on the same consent is a
    // double-open.
    const { base: prompt } = buildBoardManagerPrompt({
      studentName: "Alex",
      availableBoards: [],
      enabledApps: [DRAWING, PICTURE_SEARCH],
    } as any);

    expect(prompt).not.toContain("`open_app` — open an app");
    expect(prompt).toContain("The DEVICE opens apps ITSELF");
    expect(prompt).toContain('never build an "open it"');
    // The offer path stays fully specified.
    expect(prompt).toContain("open.appQuery");
  });

  test("the prompt tells it to fill the query and warns what happens if it does not", () => {
    const { base: prompt } = buildBoardManagerPrompt({
      studentName: "Alex",
      availableBoards: [],
      enabledApps: [DRAWING, PICTURE_SEARCH],
    } as any);

    expect(prompt).toContain("<apps_context>");
    expect(prompt).toContain("open.appQuery");
    // The consequence, stated — "opens empty" is the failure this whole change
    // exists to prevent, so the model is told it outright.
    expect(prompt).toContain("open EMPTY");
    expect(prompt).toContain(PICTURE_SEARCH.queryHint);
  });
});

// ── The registry contract the above depends on ──────────────────────────────

describe("registry queryHint", () => {
  test("picture_search declares one and marks it REQUIRED", () => {
    const hint = getAppDefinition(PICTURE_SEARCH_APP_ID)!.queryHint;
    expect(hint).toBeDefined();
    expect(hint).toContain("REQUIRED");
  });

  test("apps that ignore their launch argument declare no hint", () => {
    // A hint on an app that does nothing with it would tell the Board Manager
    // to collect a query it then silently drops.
    expect(getAppDefinition("drawing")!.queryHint).toBeUndefined();
    expect(getAppDefinition("dollhouse")!.queryHint).toBeUndefined();
  });
});
