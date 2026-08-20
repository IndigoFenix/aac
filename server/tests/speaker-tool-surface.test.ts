// Verifies that Speaker's tool surface includes the tools the HTTP path
// needs (private_thought, emote, etc.) and that the Live MALFORMED
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
  test("HTTP mode (useDirectAudio=true, httpMode=true) declares private_thought", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      httpMode: true,
    });
    const tools = names(decls);
    expect(tools).toContain("private_thought");
    // Legacy name must be gone so the model isn't told a stale tool name.
    expect(tools).not.toContain("private_note");
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

  test("HTTP mode declares remain_silent (terminal silence action)", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      httpMode: true,
    });
    expect(names(decls)).toContain("remain_silent");
  });

  test("HTTP mode does NOT declare speak() (text content is the speech)", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      httpMode: true,
    });
    expect(names(decls)).not.toContain("speak");
  });

  test("Live native-audio with NO apps returns an empty surface (MALFORMED diagnostic)", () => {
    // baseConfig has enabledApps: [] — with nothing to open, the suppression is
    // total, which is the original diagnostic behaviour.
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
    });
    expect(names(decls)).toEqual([]);
  });

  test("Live native-audio WITH apps declares exactly open_app + close_app", () => {
    // The two screen tools are the whole exception to the suppression: opening
    // silently beats promising an app that never appears, and close_app takes
    // no arguments, so there is nothing in it for the model to malform.
    // Everything conversational (speak, emote, private_thought, call_monitor,
    // call_person) stays suppressed — that is where dropping the spoken reply
    // is fatal rather than merely untidy.
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      enabledApps: [{ id: "drawing", name: "Drawing", description: "A canvas." }] as any,
    });
    expect(names(decls)).toEqual(["open_app", "close_app"]);
  });

  test("Live native-audio does NOT give the Speaker call_person", () => {
    // Documented gap, not an oversight to fix silently: in the DEFAULT session
    // shape the Speaker is injected [CALLABLE CONTACTS] but cannot dial. It can
    // only open the phone_call app and let the student choose.
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      enabledApps: [{ id: "phone_call", name: "Phone Call", description: "Contacts." }] as any,
    });
    expect(names(decls)).not.toContain("call_person");
  });

  test("Live TEXT modality (useDirectAudio=false) declares speak + private_thought", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: false,
    });
    const tools = names(decls);
    expect(tools).toContain("speak");
    expect(tools).toContain("private_thought");
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

  test("HTTP mode in muted state still includes private_thought", () => {
    const decls = buildSpeakerToolDeclarations({
      ...baseConfig,
      useDirectAudio: true,
      httpMode: true,
      isMutedMode: true,
    });
    expect(names(decls)).toContain("private_thought");
  });
});
