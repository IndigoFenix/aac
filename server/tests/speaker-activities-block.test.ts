// The Speaker's awareness of launchable apps/websites. In native-audio (tools
// suppressed — the default), the Speaker has no open_app/open_website tools, so
// it used to be told NOTHING about them and never mentioned them. It now gets a
// mention-only <activities> block (the Board Manager still does the opening).
// In tool mode it keeps the tool-oriented <apps>/<websites> blocks.

import { buildSpeakerPrompt } from "../services/dual-agent/prompts/speaker.js";

const apps = [{ id: "bubbles_game", name: "Bubbles", description: "a bubble-popping game" }];
const custom = [{ id: "cust1", name: "Story Maker", description: "make stories" }];
const sites = [
  { url: "https://book-reader-beta-weld.vercel.app", label: "Book Reader", description: "a read-along book" },
];

describe("Speaker <activities> awareness block (native-audio, tools suppressed)", () => {
  test("lists apps + websites the Speaker may mention — no tool blocks, ids, or urls", () => {
    const prompt = buildSpeakerPrompt({
      studentName: "Alex", persona: "", muteState: "unmuted",
      liveAudio: true, useDirectAudio: true,
      enabledApps: apps, availableCustomApps: custom, permittedWebsites: sites,
    });
    expect(prompt).toContain("<activities>");
    expect(prompt).toContain("Bubbles");
    expect(prompt).toContain("Story Maker");
    expect(prompt).toContain("Book Reader");
    // Mention-only: no tool-oriented block, no ids/urls the model could read out.
    expect(prompt).not.toContain("<apps>");
    expect(prompt).not.toContain("<websites>");
    expect(prompt).not.toContain("bubbles_game");
    expect(prompt).not.toContain("book-reader-beta-weld");
  });

  test("omitted entirely when there are no apps or websites", () => {
    const prompt = buildSpeakerPrompt({
      studentName: "Alex", persona: "", muteState: "unmuted",
      liveAudio: true, useDirectAudio: true,
    });
    expect(prompt).not.toContain("<activities>");
  });
});

describe("Speaker tool blocks (tool surface present)", () => {
  test("non-live tool mode uses <apps>/<websites> with the tools, not <activities>", () => {
    const prompt = buildSpeakerPrompt({
      studentName: "Alex", persona: "", muteState: "unmuted",
      liveAudio: false,
      enabledApps: apps, permittedWebsites: sites,
    });
    expect(prompt).toContain("<apps>");
    expect(prompt).toContain("open_app");
    expect(prompt).toContain("<websites>");
    expect(prompt).toContain("open_website");
    expect(prompt).not.toContain("<activities>");
  });

  test("muted native-audio restores the tool blocks (mute lifts suppression)", () => {
    const prompt = buildSpeakerPrompt({
      studentName: "Alex", persona: "", muteState: "muted",
      liveAudio: true, useDirectAudio: true,
      enabledApps: apps, permittedWebsites: sites,
    });
    expect(prompt).toContain("<apps>");
    expect(prompt).not.toContain("<activities>");
  });
});
