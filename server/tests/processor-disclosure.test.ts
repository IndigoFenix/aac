// server/tests/processor-disclosure.test.ts
//
// AKIM §18.5 (accounting of disclosures) / §14 (cross-border evidence).
//
// Two halves, for the same reason auth-is-active.test.ts has two:
//
//  1. The recorder's BEHAVIOUR is tested directly against an injected sink —
//     no DB, no provider, no credentials. Coalescing, the contextMissing row,
//     explicit-beats-ambient, the crm_chat skip, the provider-key mapping and
//     the row shape are all pure functions of the call sequence.
//
//  2. The WIRING is pinned by reading the source. Every egress family had to
//     be found by hand (there is no choke point: six HTTP provider impls, a
//     WebSocket provider, the TTS facade's per-branch routing, the STT
//     services and a raw Anthropic SDK call in deep analysis). A behavioural
//     test could only ever cover the one path it exercises, and the failure
//     this guards against is precisely that a NEW send path is added without
//     a recordDisclosure call — invisible until an audit asks for the log.

import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  recordDisclosure,
  runWithDisclosureContext,
  getDisclosureContext,
  flushDisclosures,
  processorForProvider,
  setDisclosureSink,
  setDisclosureClock,
  resetDisclosureState,
  DISCLOSURE_WINDOW_MS,
  PROCESSOR_DISCLOSURE_CONTEXT_MISSING,
  type DisclosureLogEntry,
  type DisclosureContext,
} from "../services/processorDisclosure";

const src = (rel: string) => readFileSync(path.join(process.cwd(), rel), "utf8");

describe("recordDisclosure", () => {
  let rows: DisclosureLogEntry[];
  let now: number;

  const ctx: DisclosureContext = {
    studentId: "student-1",
    sessionId: "session-1",
    userId: "user-1",
    instituteId: "inst-1",
    useCase: "aac_chat",
  };

  beforeEach(() => {
    rows = [];
    now = 1_000_000;
    setDisclosureSink((e) => rows.push(e));
    setDisclosureClock(() => now);
    resetDisclosureState();
  });

  afterEach(() => {
    setDisclosureSink(null);
    setDisclosureClock(null);
    resetDisclosureState();
  });

  describe("row shape", () => {
    it("writes a processor_disclosure row on the first send", () => {
      recordDisclosure({ processor: "google", channel: "live", model: "gemini-live", context: ctx });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        eventType: "processor_disclosure",
        subjectType1: "student",
        subjectId1: "student-1",
        subjectType2: "chat_session",
        subjectId2: "session-1",
        userId: "user-1",
        instituteId: "inst-1",
        isAiInitiated: true,
      });
      expect(rows[0].details).toMatchObject({
        processor: "google",
        channel: "live",
        model: "gemini-live",
        useCase: "aac_chat",
        count: 1,
      });
    });

    it("omits subject 2 when there is no session", () => {
      recordDisclosure({
        processor: "elevenlabs",
        channel: "tts",
        context: { studentId: "s", useCase: "tts" },
      });
      expect(rows[0].subjectType2).toBeNull();
      expect(rows[0].subjectId2).toBeNull();
    });

    it("records the endpoint so a Vertex call is distinguishable from the public API", () => {
      recordDisclosure({ processor: "google", channel: "chat", endpoint: "vertex", context: ctx });
      expect(rows[0].details.endpoint).toBe("vertex");
    });
  });

  describe("coalescing", () => {
    it("writes once per key per window, then flushes the accumulated count", () => {
      // A live session's frame rate: many sends inside one window.
      for (let i = 0; i < 50; i++) {
        recordDisclosure({ processor: "google", channel: "live", context: ctx });
      }
      expect(rows).toHaveLength(1);
      expect(rows[0].details.count).toBe(1);

      // Window rolls: the 49 suppressed sends are flushed as ONE row, and the
      // send that rolled it opens the next window with its own row.
      now += DISCLOSURE_WINDOW_MS;
      recordDisclosure({ processor: "google", channel: "live", context: ctx });

      expect(rows).toHaveLength(3);
      expect(rows[1].details).toMatchObject({ count: 49, coalesced: true });
      expect(rows[2].details).toMatchObject({ count: 1 });
      expect(rows[2].details.coalesced).toBeUndefined();

      // The two rows sum to the true number of sends in the first window.
      expect((rows[0].details.count as number) + (rows[1].details.count as number)).toBe(50);
    });

    it("flushDisclosures() flushes an open window without waiting for it to roll", () => {
      recordDisclosure({ processor: "anthropic", channel: "chat", context: ctx });
      recordDisclosure({ processor: "anthropic", channel: "chat", context: ctx });
      recordDisclosure({ processor: "anthropic", channel: "chat", context: ctx });
      expect(rows).toHaveLength(1);

      flushDisclosures();
      expect(rows).toHaveLength(2);
      expect(rows[1].details).toMatchObject({ count: 2, coalesced: true });
    });

    it("keeps separate windows per student, session, processor, use case and channel", () => {
      const base = { processor: "google" as const, channel: "live" as const };
      recordDisclosure({ ...base, context: ctx });
      recordDisclosure({ ...base, context: { ...ctx, studentId: "student-2" } });
      recordDisclosure({ ...base, context: { ...ctx, sessionId: "session-2" } });
      recordDisclosure({ ...base, context: { ...ctx, useCase: "aac_moderator" } });
      recordDisclosure({ ...base, channel: "chat", context: ctx });
      recordDisclosure({ processor: "anthropic", channel: "live", context: ctx });
      expect(rows).toHaveLength(6);
    });

    it("sweeps an idle key's tail when a different key is still active", () => {
      recordDisclosure({ processor: "google", channel: "live", context: ctx });
      recordDisclosure({ processor: "google", channel: "live", context: ctx });
      expect(rows).toHaveLength(1);

      // The quiet session never sends again; an unrelated one does.
      now += DISCLOSURE_WINDOW_MS + 1;
      recordDisclosure({
        processor: "anthropic",
        channel: "chat",
        context: { studentId: "other", useCase: "clinician" },
      });

      const flushed = rows.find((r) => r.details.coalesced === true);
      expect(flushed?.subjectId1).toBe("student-1");
      expect(flushed?.details.count).toBe(1);
    });
  });

  describe("context resolution", () => {
    it("uses the ambient context when none is passed", () => {
      runWithDisclosureContext(ctx, () => {
        recordDisclosure({ processor: "anthropic", channel: "structured" });
      });
      expect(rows[0].subjectId1).toBe("student-1");
      expect(rows[0].details.useCase).toBe("aac_chat");
    });

    it("lets an explicit context beat the ambient one", () => {
      runWithDisclosureContext(ctx, () => {
        recordDisclosure({
          processor: "anthropic",
          channel: "structured",
          context: { studentId: "explicit", useCase: "deep_analysis" },
        });
      });
      expect(rows[0].subjectId1).toBe("explicit");
      expect(rows[0].details.useCase).toBe("deep_analysis");
    });

    it("exposes the ambient context to callers that need to forward it", () => {
      expect(getDisclosureContext()).toBeUndefined();
      runWithDisclosureContext(ctx, () => {
        expect(getDisclosureContext()).toEqual(ctx);
      });
    });

    it("survives an await inside the context", async () => {
      await runWithDisclosureContext(ctx, async () => {
        await Promise.resolve();
        recordDisclosure({ processor: "google", channel: "chat" });
      });
      expect(rows[0].subjectId1).toBe("student-1");
    });
  });

  describe("fail loud", () => {
    it("writes the row anyway when no context is attached, marked contextMissing", () => {
      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        recordDisclosure({ processor: "openai", channel: "chat", model: "gpt-4o-mini" });
      } finally {
        spy.mockRestore();
      }
      expect(rows).toHaveLength(1);
      expect(rows[0].subjectId1).toBeNull();
      expect(rows[0].subjectType1).toBe("student");
      expect(rows[0].subjectType2).toBeNull();
      expect(rows[0].isAiInitiated).toBe(true);
      expect(rows[0].details).toMatchObject({ contextMissing: true, useCase: "unknown", count: 1 });
    });

    it("prints the metric-filter marker once per process per call site", () => {
      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        recordDisclosure({ processor: "openai", channel: "chat" });
        recordDisclosure({ processor: "openai", channel: "chat" });
        recordDisclosure({ processor: "openai", channel: "stt" });
        const marked = spy.mock.calls.filter((c) =>
          String(c[0]).includes(PROCESSOR_DISCLOSURE_CONTEXT_MISSING),
        );
        expect(marked).toHaveLength(2); // chat once, stt once — not three
      } finally {
        spy.mockRestore();
      }
      // Every send is still logged, even the repeats.
      expect(rows).toHaveLength(3);
    });

    it("does not coalesce unattributed sends — each is written straight through", () => {
      const spy = jest.spyOn(console, "error").mockImplementation(() => {});
      try {
        recordDisclosure({ processor: "openai", channel: "chat" });
        recordDisclosure({ processor: "openai", channel: "chat" });
      } finally {
        spy.mockRestore();
      }
      expect(rows).toHaveLength(2);
    });
  });

  describe("non-PHI use cases", () => {
    it("skips crm_chat entirely — anonymous visitors, no student", () => {
      recordDisclosure({
        processor: "anthropic",
        channel: "chat",
        context: { studentId: null, useCase: "crm_chat" },
      });
      runWithDisclosureContext({ studentId: null, useCase: "crm_chat" }, () => {
        recordDisclosure({ processor: "anthropic", channel: "chat" });
      });
      expect(rows).toHaveLength(0);
    });

    it("skips aac_sim — the child in the simulation is synthetic", () => {
      recordDisclosure({
        processor: "google",
        channel: "structured",
        context: { studentId: null, useCase: "aac_sim" },
      });
      expect(rows).toHaveLength(0);
    });

    it("does NOT skip a PHI use case that merely has a null student", () => {
      // A student-less send is a coverage question, not a licence to drop it.
      recordDisclosure({
        processor: "elevenlabs",
        channel: "tts",
        context: { studentId: null, userId: "u", useCase: "tts" },
      });
      expect(rows).toHaveLength(1);
    });
  });
});

describe("processorForProvider", () => {
  it("maps internal provider keys to the legal entity that receives the data", () => {
    expect(processorForProvider("claude")).toBe("anthropic");
    expect(processorForProvider("gemini")).toBe("google");
    expect(processorForProvider("openai")).toBe("openai");
  });

  it("throws on an unknown provider rather than logging it as an existing one", () => {
    expect(() => processorForProvider("mistral")).toThrow(/unknown LLM provider/);
  });
});

// ---------------------------------------------------------------------------
// Source-level wiring pins
// ---------------------------------------------------------------------------

describe("every LLM provider implementation records its send", () => {
  const impls = [
    ["claude-structured", "server/services/providers/claude-structured.ts", "anthropic"],
    ["claude-chat", "server/services/providers/claude-chat.ts", "anthropic"],
    ["gemini-structured", "server/services/providers/gemini-structured.ts", "google"],
    ["gemini-chat", "server/services/providers/gemini-chat.ts", "google"],
    ["openai-structured", "server/services/providers/openai-structured.ts", "openai"],
    ["openai-chat", "server/services/providers/openai-chat.ts", "openai"],
  ] as const;

  it.each(impls)("%s calls recordDisclosure for %s", (_name, file, processor) => {
    const s = src(file);
    expect(s).toContain("recordDisclosure(");
    expect(s).toMatch(new RegExp(`processor: "${processor}"`));
  });

  it.each(impls)("%s forwards the request's own disclosure context", (_name, file) => {
    expect(src(file)).toMatch(/context: request\.disclosure|context: request\.disclosure,/);
  });

  it("carries the ids on the request DTOs so a queued turn keeps them", () => {
    expect(src("server/services/providers/structured-provider.ts")).toContain(
      "disclosure?: DisclosureContext",
    );
    expect(src("server/services/providers/streaming-provider.ts")).toContain(
      "disclosure?: DisclosureContext",
    );
  });
});

describe("the Gemini Live socket records every send, not just the connect", () => {
  const s = src("server/services/dual-agent/gemini-live-provider.ts");

  it("has one recording helper bound to the connect config's ids", () => {
    expect(s).toMatch(/private recordEgress\(\): void \{[\s\S]{0,400}?recordDisclosure\(\{/);
    expect(s).toContain("context: this.config.disclosure");
    expect(s).toMatch(/channel: "live"/);
  });

  it("connect records — the system prompt alone carries the student's profile", () => {
    expect(s).toMatch(/this\.config = config;[\s\S]{0,400}?this\.recordEgress\(\)/);
  });

  it.each([
    "sendFrame",
    "sendFrameWithPrompt",
    "sendAudio",
    "sendAudioWithPrompt",
    "sendMessage",
    "sendContextInjection",
    "sendToolResponse",
    "sendToolResponseAsContent",
  ])("%s records", (method) => {
    // The call sits in the first few lines of the method body, after the
    // connected-guard.
    const re = new RegExp(`\\b${method}\\([^)]*\\)[^{]*\\{[\\s\\S]{0,400}?this\\.recordEgress\\(\\)`);
    expect(s).toMatch(re);
  });
});

describe("every Live provider construction site supplies the ids", () => {
  it.each([
    ["observer", "server/services/dual-agent/observer-agent.ts"],
    ["speaker", "server/services/dual-agent/speaker-agent.ts"],
    ["live board manager", "server/services/dual-agent/live-board-manager-agent.ts"],
    ["legacy live relay", "server/services/dual-agent/live-relay.ts"],
  ])("%s passes disclosure into the connect config", (_name, file) => {
    const s = src(file);
    expect(s).toContain("new GeminiLiveProvider(");
    expect(s).toMatch(/disclosure:/);
  });

  it("the config type has somewhere to put them", () => {
    expect(src("server/services/dual-agent/live-provider.ts")).toContain(
      "disclosure?: DisclosureContext",
    );
  });

  it("the coordinator enters a disclosure context on every inbound message", () => {
    const s = src("server/services/dual-agent/agent-coordinator.ts");
    expect(s).toMatch(/withSessionContext[\s\S]{0,300}?runWithDisclosureContext/);
    expect(s).toMatch(/private disclosureContext\(\): DisclosureContext/);
  });

  it("the legacy relay does the same on its own socket", () => {
    const s = src("server/services/dual-agent/live-relay.ts");
    expect(s).toContain("runWithDisclosureContext(this.disclosureContext(), handle)");
  });
});

describe("the TTS facade records at the branch it actually took", () => {
  const s = src("server/services/voice/tts-facade.ts");

  it("records before the attempt, not after the success", () => {
    // A request that fails mid-flight has already left the building, so the
    // recording must precede the await — never sit next to onUsage.
    expect(s).toMatch(
      /recordTtsDisclosure\("elevenlabs"[\s\S]{0,120}?try \{[\s\S]{0,200}?elevenlabsTtsService/,
    );
  });

  it("names ElevenLabs on both ElevenLabs branches of both entry points", () => {
    expect(s.match(/recordTtsDisclosure\("elevenlabs"/g) ?? []).toHaveLength(4);
  });

  it("names Google on the Google TTS and Gemini-Live branches", () => {
    // synthesize → google; synthesizeStream → gemini-live + google.
    expect(s.match(/recordTtsDisclosure\("google"/g) ?? []).toHaveLength(3);
    expect(s).toContain('recordTtsDisclosure("google", "gemini-live-tts"');
  });

  it("accepts the ids from the caller, since routing is decided in here", () => {
    expect(s).toContain("disclosure?: DisclosureContext");
  });
});

describe("speech-to-text records too — the audio is the child's own voice", () => {
  it("google STT records on batch, streaming and language detection", () => {
    const s = src("server/services/voice/google-stt-service.ts");
    expect(s.match(/recordDisclosure\(\{/g) ?? []).toHaveLength(3);
    expect(s).toMatch(/channel: "stt"/);
  });

  it("whisper records", () => {
    const s = src("server/services/voice/whisper-service.ts");
    expect(s).toContain("recordDisclosure({");
    expect(s).toMatch(/processor: "openai"[\s\S]{0,80}channel: "stt"/);
  });
});

describe("deep analysis records its own send — it bypasses the provider factory", () => {
  const s = src("server/services/deepAnalysisService.ts");

  it("records immediately before the raw Anthropic SDK call", () => {
    expect(s).toMatch(/recordDisclosure\(\{[\s\S]{0,400}?\}\);\s*const stream = client\.messages\.stream\(/);
  });

  it("names the student from the row, not from an ambient context", () => {
    expect(s).toMatch(/context: \{[\s\S]{0,200}?studentId: row\.studentId/);
    expect(s).toContain('useCase: "deep_analysis"');
  });
});

describe("the clinician/AAC chat path carries ids the manager would otherwise lose", () => {
  it("sessionService attaches them to the provider config", () => {
    const s = src("server/services/sessionService.ts");
    expect(s).toMatch(/disclosure: \{[\s\S]{0,300}?useCase: llmUseCase/);
  });

  it("chat-handler passes them to its own internal summarization calls", () => {
    const s = src("server/services/chat/chat-handler.ts");
    expect(s.match(/new GPT\(undefined, this\.disclosure\)/g) ?? []).toHaveLength(2);
    expect(s).toContain("disclosure: this.disclosure");
  });

  it("the CRM chat declares crm_chat explicitly rather than passing nothing", () => {
    expect(src("server/services/crmChat/crmChatService.ts")).toContain('useCase: "crm_chat"');
  });
});

describe("the Monitor — the densest PHI in the system — names its student", () => {
  const s = src("server/services/dual-agent/monitor-agent.ts");
  it("attaches a disclosure context to every GPT it builds", () => {
    const constructions = s.match(/new GPT\(/g) ?? [];
    const attached = s.match(/disclosure: this\.disclosureContext\(\)/g) ?? [];
    expect(attached.length).toBe(constructions.length);
    expect(constructions.length).toBeGreaterThan(0);
  });
});

describe("the activity log can answer the §18.5 question", () => {
  it("filters by event type and subject together", () => {
    const s = src("server/services/activityLogService.ts");
    expect(s).toContain("eventType?: ActivityEventType");
    expect(s).toContain("subjectId?: string");
    // Subject id matches EITHER position — a session-scoped row still answers
    // "every disclosure about student X".
    expect(s).toMatch(/subjectId1[\s\S]{0,80}OR[\s\S]{0,80}subjectId2/);
  });
});

describe("the follow-up round's remaining sites", () => {
  it("the legacy dual-agent service records its server-side TTS", () => {
    const s = src("server/services/dual-agent/dual-agent-service.ts");
    // The client-TTS branch deliberately records nothing — that synthesis
    // happens on the device with the family's own ElevenLabs key, so no PHI
    // leaves this system there.
    expect(s).toMatch(/ttsFacade\.synthesizeStream\([\s\S]{0,200}?disclosure,/);
    expect(s).toContain("disclosure?: DisclosureContext");
  });

  it("the guessing seeder attaches the ids it is given", () => {
    const s = src("server/services/dual-agent/guessing-seeder.ts");
    expect(s).toContain("disclosure: input.disclosure");
  });

  it("the venue-menu chain carries the student from the request to the model", () => {
    // controller → capture/web service → cacheMenu/fetcher → extraction+refinement
    expect(src("server/controllers/venueMenuController.ts")).toMatch(
      /disclosure: \{[\s\S]{0,200}?useCase: "venue_menu_camera"/,
    );
    expect(src("server/controllers/venueMenuController.ts")).toMatch(
      /disclosure: \{[\s\S]{0,200}?useCase: "venue_menu_web"/,
    );
    for (const f of [
      "server/services/venue-menus/menu-capture-service.ts",
      "server/services/venue-menus/web-menu-service.ts",
      "server/services/venue-menus/menu-cache.ts",
      "server/services/venue-menus/web-menu-fetcher.ts",
    ]) {
      expect(src(f)).toContain("disclosure?: DisclosureContext");
      // Each link forwards what it was handed — `input` or `options`
      // depending on the function's own parameter name.
      expect(src(f)).toMatch(/(input|options)\.disclosure/);
    }
  });

  it("the simulation DECLARES itself non-PHI rather than passing nothing", () => {
    for (const f of ["server/services/aac-sim/child.ts", "server/services/aac-sim/judge.ts"]) {
      expect(src(f)).toContain('useCase: "aac_sim"');
      expect(src(f)).toContain("disclosure: SIM_DISCLOSURE");
    }
  });

  it("both entry points flush open windows on SIGTERM", () => {
    for (const f of ["server/index.ts", "server/app.prod.ts"]) {
      expect(src(f)).toContain("installDisclosureShutdownFlush()");
    }
    const rec = src("server/services/processorDisclosure.ts");
    // Registering a SIGTERM listener cancels Node's default terminate — the
    // handler MUST exit, or a deploy hangs until the kill timeout.
    expect(rec).toMatch(/process\.on\("SIGTERM"[\s\S]{0,400}?process\.exit\(0\)/);
  });
});
