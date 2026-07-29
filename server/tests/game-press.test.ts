// World-engine game ↔ AAC integration (stage 2), server side.
//
// Pins the two per-student "game options" gates and the game_press flow:
//  - resolveGameOptions reads aacSettings.appConfig.gameOptions with defaults
//    useAi="energy", studentVoice=true (nested under appConfig deliberately —
//    no DB migration, appConfig is already whitelisted).
//  - runGamePress (the pure orchestrator AgentCoordinator.handleGamePress
//    wires to its real chokepoints) voices the press in the student's voice,
//    logs it as [GAME PRESS], publishes to the conversation room, and injects
//    at most a PASSIVE Observer context note — it can never wake an agent
//    into a model turn (the deps surface has no speaker/board hooks at all,
//    and the test asserts only the expected callbacks fire).
//  - useAi="off" suppresses both the press context note and [GAME OBSERVATION]
//    forwarding; "energy" defers to the coordinator's existing low-band
//    predicate (injected as lowBandActive); [GAME REQUEST] (an active ask) is
//    dropped only when "off".
//
// DB-free by design (belongs in test:unit, not integration/): the module under
// test has zero imports, all effects arrive via injected deps.

import {
  resolveGameOptions,
  gameAiAllowed,
  classifyGameContext,
  shouldForwardGameContext,
  runGamePress,
  GAME_OPTIONS_DEFAULTS,
  type GameOptions,
  type GamePressDeps,
  type GamePressMessage,
} from "../services/dual-agent/game-options";

// ---------------------------------------------------------------------------
// Test harness — capture every dep call so we can assert exactly what fired.
// ---------------------------------------------------------------------------

interface Calls {
  utterances: string[];
  tts: string[];
  roomPublishes: string[];
  userLogs: string[];
  recorded: string[];
  observerContext: string[];
  engagement: number;
  notes: string[];
}

function makeDeps(options: GameOptions, lowBand = false): { deps: GamePressDeps; calls: Calls } {
  const calls: Calls = {
    utterances: [], tts: [], roomPublishes: [], userLogs: [],
    recorded: [], observerContext: [], engagement: 0, notes: [],
  };
  const deps: GamePressDeps = {
    options,
    lowBandActive: () => lowBand,
    sendUtterance: (t) => calls.utterances.push(t),
    streamStudentTts: async (t) => { calls.tts.push(t); },
    publishToRoom: (t) => calls.roomPublishes.push(t),
    appendUserLog: (c) => calls.userLogs.push(c),
    recordUtterance: (t) => calls.recorded.push(t),
    injectObserverContext: (t) => calls.observerContext.push(t),
    noteEngagement: () => { calls.engagement++; },
    note: (m) => calls.notes.push(m),
  };
  return { deps, calls };
}

const press = (over: Partial<GamePressMessage> = {}): GamePressMessage => ({
  type: "game_press",
  text: "Mara, please water the plants",
  glyph: "mara+water+plant",
  ...over,
});

// ---------------------------------------------------------------------------
// resolveGameOptions
// ---------------------------------------------------------------------------

describe("resolveGameOptions", () => {
  it("defaults to useAi='energy', studentVoice=true when nothing is stored", () => {
    expect(resolveGameOptions(undefined)).toEqual({ useAi: "energy", studentVoice: true });
    expect(resolveGameOptions(null)).toEqual(GAME_OPTIONS_DEFAULTS);
    expect(resolveGameOptions({})).toEqual(GAME_OPTIONS_DEFAULTS);
    expect(resolveGameOptions({ appConfig: {} })).toEqual(GAME_OPTIONS_DEFAULTS);
    expect(resolveGameOptions({ appConfig: { gameOptions: {} } })).toEqual(GAME_OPTIONS_DEFAULTS);
  });

  it("reads explicit values from appConfig.gameOptions", () => {
    const aac = { appConfig: { gameOptions: { useAi: "off", studentVoice: false } } };
    expect(resolveGameOptions(aac)).toEqual({ useAi: "off", studentVoice: false });
    expect(resolveGameOptions({ appConfig: { gameOptions: { useAi: "on" } } }))
      .toEqual({ useAi: "on", studentVoice: true });
  });

  it("falls back to the default on an unknown useAi value", () => {
    expect(resolveGameOptions({ appConfig: { gameOptions: { useAi: "sometimes" } } }).useAi)
      .toBe("energy");
  });

  it("ignores gameOptions from other apps' entries (only the gameOptions key counts)", () => {
    const aac = { appConfig: { dollhouse: { enabled: true, useAi: "off" } } };
    expect(resolveGameOptions(aac)).toEqual(GAME_OPTIONS_DEFAULTS);
  });
});

// ---------------------------------------------------------------------------
// gameAiAllowed / shouldForwardGameContext — the useAi gates
// ---------------------------------------------------------------------------

describe("useAi gating", () => {
  const opts = (useAi: GameOptions["useAi"]): GameOptions => ({ useAi, studentVoice: true });

  it("'on' always allows; 'off' never allows", () => {
    expect(gameAiAllowed(opts("on"), false)).toBe(true);
    expect(gameAiAllowed(opts("on"), true)).toBe(true);
    expect(gameAiAllowed(opts("off"), false)).toBe(false);
    expect(gameAiAllowed(opts("off"), true)).toBe(false);
  });

  it("'energy' defers to the low-band predicate (allowed only when NOT low)", () => {
    expect(gameAiAllowed(opts("energy"), false)).toBe(true);
    expect(gameAiAllowed(opts("energy"), true)).toBe(false);
  });

  it("classifies the GameEmbed prefixes", () => {
    expect(classifyGameContext("[GAME OBSERVATION] (game: dollhouse)\nstate")).toBe("observation");
    expect(classifyGameContext("[GAME REQUEST] (game: dollhouse)\nplease comment")).toBe("request");
    expect(classifyGameContext("[OWN_SPEECH] hello")).toBeNull();
    expect(classifyGameContext("random text")).toBeNull();
  });

  it("[GAME OBSERVATION] obeys the full gate; [GAME REQUEST] is dropped only when 'off'", () => {
    // observation: off → drop; energy+low → drop; energy+ok / on → forward
    expect(shouldForwardGameContext("observation", opts("off"), false)).toBe(false);
    expect(shouldForwardGameContext("observation", opts("energy"), true)).toBe(false);
    expect(shouldForwardGameContext("observation", opts("energy"), false)).toBe(true);
    expect(shouldForwardGameContext("observation", opts("on"), true)).toBe(true);
    // request: only "off" drops it — an active ask survives the low band
    expect(shouldForwardGameContext("request", opts("off"), false)).toBe(false);
    expect(shouldForwardGameContext("request", opts("off"), true)).toBe(false);
    expect(shouldForwardGameContext("request", opts("energy"), true)).toBe(true);
    expect(shouldForwardGameContext("request", opts("on"), false)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// runGamePress — voices + logs + publishes, never wakes an agent
// ---------------------------------------------------------------------------

describe("runGamePress", () => {
  it("voiced press: UI utterance + student TTS + [GAME PRESS] log + MLU record + passive context; no direct room publish (the TTS chokepoint publishes)", async () => {
    const { deps, calls } = makeDeps({ useAi: "on", studentVoice: true });
    await runGamePress(press(), deps);

    expect(calls.utterances).toEqual(["Mara, please water the plants"]);
    expect(calls.tts).toEqual(["Mara, please water the plants"]);
    // The room publish lives INSIDE the streamStudentTts chokepoint — the
    // orchestrator must not publish a second time on the voiced path.
    expect(calls.roomPublishes).toEqual([]);
    expect(calls.userLogs).toEqual([`[GAME PRESS] "Mara, please water the plants"`]);
    expect(calls.recorded).toEqual(["Mara, please water the plants"]);
    expect(calls.observerContext).toEqual([
      `[GAME] The student said (via the game board): "Mara, please water the plants"`,
    ]);
    expect(calls.engagement).toBe(1);
  });

  it("non-voiced press (voice:false): no server TTS, but the utterance still reaches the conversation room + log + MLU", async () => {
    const { deps, calls } = makeDeps({ useAi: "on", studentVoice: true });
    await runGamePress(press({ voice: false }), deps);

    expect(calls.tts).toEqual([]);
    expect(calls.roomPublishes).toEqual(["Mara, please water the plants"]);
    expect(calls.userLogs).toEqual([`[GAME PRESS] "Mara, please water the plants"`]);
    expect(calls.recorded).toEqual(["Mara, please water the plants"]);
  });

  it("absent voice flag falls back to the resolved studentVoice setting", async () => {
    const off = makeDeps({ useAi: "on", studentVoice: false });
    await runGamePress(press(), off.deps);
    expect(off.calls.tts).toEqual([]);
    expect(off.calls.roomPublishes).toEqual(["Mara, please water the plants"]);

    const on = makeDeps({ useAi: "on", studentVoice: true });
    await runGamePress(press(), on.deps);
    expect(on.calls.tts).toEqual(["Mara, please water the plants"]);

    // An explicit client voice:true overrides a false setting (client already
    // consulted the setting; explicit wins).
    const explicit = makeDeps({ useAi: "on", studentVoice: false });
    await runGamePress(press({ voice: true }), explicit.deps);
    expect(explicit.calls.tts).toEqual(["Mara, please water the plants"]);
  });

  it("useAi='off' suppresses the Observer context note (and the engagement stamp) but everything else still happens", async () => {
    const { deps, calls } = makeDeps({ useAi: "off", studentVoice: true });
    await runGamePress(press(), deps);

    expect(calls.observerContext).toEqual([]);
    expect(calls.engagement).toBe(0);
    expect(calls.notes.length).toBe(1);
    expect(calls.notes[0]).toContain("useAi=off");
    // The press is still a real utterance — voiced, logged, recorded.
    expect(calls.tts).toEqual(["Mara, please water the plants"]);
    expect(calls.userLogs.length).toBe(1);
    expect(calls.recorded.length).toBe(1);
  });

  it("useAi='energy' defers to the low-band predicate", async () => {
    const healthy = makeDeps({ useAi: "energy", studentVoice: true }, /* lowBand */ false);
    await runGamePress(press(), healthy.deps);
    expect(healthy.calls.observerContext.length).toBe(1);

    const low = makeDeps({ useAi: "energy", studentVoice: true }, /* lowBand */ true);
    await runGamePress(press(), low.deps);
    expect(low.calls.observerContext).toEqual([]);
    expect(low.calls.notes[0]).toContain("low band");
  });

  it("never fires anything beyond the declared deps (no agent turn, no board rebuild)", async () => {
    // The deps surface IS the complete set of effects runGamePress can have.
    // Freeze an audit of every callback invocation and pin the exact set.
    const invoked: string[] = [];
    const deps: GamePressDeps = {
      options: { useAi: "on", studentVoice: true },
      lowBandActive: () => { invoked.push("lowBandActive"); return false; },
      sendUtterance: () => { invoked.push("sendUtterance"); },
      streamStudentTts: async () => { invoked.push("streamStudentTts"); },
      publishToRoom: () => { invoked.push("publishToRoom"); },
      appendUserLog: () => { invoked.push("appendUserLog"); },
      recordUtterance: () => { invoked.push("recordUtterance"); },
      injectObserverContext: () => { invoked.push("injectObserverContext"); },
      noteEngagement: () => { invoked.push("noteEngagement"); },
      note: () => { invoked.push("note"); },
    };
    await runGamePress(press(), deps);
    expect(invoked).toEqual([
      "sendUtterance",
      "streamStudentTts",
      "appendUserLog",
      "recordUtterance",
      "lowBandActive",
      "noteEngagement",
      "injectObserverContext",
    ]);
  });

  it("a TTS failure doesn't abort the log/record/context tail", async () => {
    const { deps, calls } = makeDeps({ useAi: "on", studentVoice: true });
    deps.streamStudentTts = async () => { throw new Error("tts down"); };
    await runGamePress(press(), deps);
    expect(calls.userLogs.length).toBe(1);
    expect(calls.recorded.length).toBe(1);
    expect(calls.observerContext.length).toBe(1);
  });

  it("empty / whitespace-only text is a no-op", async () => {
    const { deps, calls } = makeDeps({ useAi: "on", studentVoice: true });
    await runGamePress(press({ text: "   " }), deps);
    expect(calls.utterances).toEqual([]);
    expect(calls.tts).toEqual([]);
    expect(calls.userLogs).toEqual([]);
    expect(calls.recorded).toEqual([]);
    expect(calls.observerContext).toEqual([]);
  });
});
