// Verifies that Speaker's tool surface includes the tools the HTTP path
// needs (private_note, emote, etc.) and that the Live MALFORMED
// short-circuit is correctly scoped to Live mode only.

import {
  buildSpeakerToolDeclarations,
  type SpeakerToolConfig,
} from "../services/dual-agent/tool-declarations-speaker";

function names(decls: ReturnType<typeof buildSpeakerToolDeclarations>): string[] {
  return decls.flatMap(t => (t.functionDeclarations ?? []).map(d => d.name ?? ""));
}

const baseConfig: SpeakerToolConfig = {
  useDirectAudio: false,
  enabledApps: [],
  availableCustomApps: [],
  permittedWebsites: [],
};

describe("buildSpeakerToolDeclarations", () => {
  test("HTTP mode (useDirectAudio=true, httpMode=true) declares private_note", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      httpMode: true,
    });
    const tools = names(decls);
    expect(tools).toContain("private_note");
  });

  test("HTTP mode (useDirectAudio=true, httpMode=true) declares emote", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      httpMode: true,
    });
    expect(names(decls)).toContain("emote");
  });

  test("HTTP mode (useDirectAudio=true, httpMode=true) declares call_monitor", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      httpMode: true,
    });
    expect(names(decls)).toContain("call_monitor");
  });

  test("HTTP mode does NOT declare speak() (text content is the speech)", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      httpMode: true,
    });
    expect(names(decls)).not.toContain("speak");
  });

  test("Live native-audio (useDirectAudio=true, no httpMode) still returns empty (MALFORMED diagnostic)", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
    });
    expect(names(decls)).toEqual([]);
  });

  test("Live TEXT modality (useDirectAudio=false) declares speak + private_note", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: false,
    });
    const tools = names(decls);
    expect(tools).toContain("speak");
    expect(tools).toContain("private_note");
  });

  test("HTTP mode with apps declares open_app and close_app", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      httpMode: true,
      enabledApps: [
        { id: "youtube", name: "YouTube", description: "videos", enabledByDefault: true, icon: "" } as any,
      ],
    });
    const tools = names(decls);
    expect(tools).toContain("open_app");
    expect(tools).toContain("close_app");
  });

  test("HTTP mode in muted state still includes private_note", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      httpMode: true,
      isMutedMode: true,
    });
    expect(names(decls)).toContain("private_note");
  });
});
