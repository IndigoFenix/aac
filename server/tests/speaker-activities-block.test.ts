// The Speaker's app catalogue.
//
// HISTORY, because the assertions below invert what they used to say. In live
// native audio the Speaker originally had NO tools, so it got a mention-only
// <activities> list — names, deliberately no ids, because an id it could not
// call was just something it might read aloud. On 2026-08-19 it gained open_app
// as its single tool, and nobody revisited the list: for a day it was told to
// "call open_app(app_id)" while being shown app NAMES ONLY. The ids reached it
// solely through the tool description's comma-separated tail, with nothing
// mapping one to the other — so it guessed, and picked apps at random.
//
// There is now ONE <apps> catalogue in both shapes, and every row IS the call
// that opens it. Websites remain the real difference: open_website exists only
// where the full tool surface does, so in live audio they are mention-only and
// the Board Manager places the button.

import { buildSpeakerPrompt } from "../services/dual-agent/prompts/speaker.js";

const apps = [{ id: "bubbles_game", name: "Bubbles", description: "a bubble-popping game" }];
const custom = [{ id: "cust1", name: "Story Maker", description: "make stories" }];
const sites = [
  { url: "https://book-reader-beta-weld.vercel.app", label: "Book Reader", description: "a read-along book" },
];

const live = {
  studentName: "Alex", persona: "", muteState: "unmuted" as const,
  liveAudio: true, useDirectAudio: true,
};

describe("Speaker <apps> catalogue — live native audio (the default)", () => {
  test("gives every app its id, because open_app can only be called with one", () => {
    const prompt = buildSpeakerPrompt({
      ...live, enabledApps: apps, availableCustomApps: custom, permittedWebsites: sites,
    });
    expect(prompt).toContain("<apps>");
    expect(prompt).toContain("Bubbles");
    expect(prompt).toContain("Story Maker");
    // The regression this file exists for: the NAME the student says, next to
    // the ID the call needs. A custom game's id is never guessable from its
    // name, so a catalogue without both is a catalogue that cannot be used.
    expect(prompt).toContain('open_app("bubbles_game")');
    expect(prompt).toContain('open_app("cust1")');
  });

  test("prints the data argument's meaning for apps that take one", () => {
    const prompt = buildSpeakerPrompt({
      ...live,
      enabledApps: [{ id: "spotify", name: "Spotify", description: "music", queryHint: "what music to play" }],
    });
    expect(prompt).toContain('open_app("spotify", "<what music to play>")');
  });

  test("refuses rather than substituting when nothing fits", () => {
    // The other half of the report: asked for something impossible, it opened
    // whatever was nearest by name. The rule needs to name the cost to the
    // student, not just forbid the act.
    const prompt = buildSpeakerPrompt({ ...live, enabledApps: apps });
    expect(prompt).toContain("NOTHING FITS?");
    expect(prompt).toContain("Never open the nearest-sounding app instead");
  });

  test("states the unprompted-open bans it kept breaking", () => {
    const prompt = buildSpeakerPrompt({ ...live, enabledApps: apps });
    expect(prompt).toContain("A topic coming up is not a request");
    expect(prompt).toContain("NEVER OPEN during the Word Finder");
  });

  test("websites are mention-only here, and never a spoken URL", () => {
    const prompt = buildSpeakerPrompt({ ...live, enabledApps: apps, permittedWebsites: sites });
    expect(prompt).toContain("Book Reader");
    expect(prompt).toContain("You cannot open these yourself");
    expect(prompt).not.toContain("open_website");
    // A URL is unspeakable and unhelpful — it exists only for the tool call,
    // which this shape does not have.
    expect(prompt).not.toContain("book-reader-beta-weld");
  });

  test("no catalogue at all when there are no apps or websites", () => {
    const prompt = buildSpeakerPrompt({ ...live });
    expect(prompt).not.toContain("<apps>");
    expect(prompt).not.toContain("<websites>");
  });
});

describe("Speaker <apps> catalogue — tool mode", () => {
  const toolMode = {
    studentName: "Alex", persona: "", muteState: "unmuted" as const, liveAudio: false,
  };

  test("same catalogue, plus the tools live audio does not have", () => {
    const prompt = buildSpeakerPrompt({ ...toolMode, enabledApps: apps, permittedWebsites: sites });
    expect(prompt).toContain("<apps>");
    expect(prompt).toContain('open_app("bubbles_game")');
    expect(prompt).toContain("<websites>");
    expect(prompt).toContain("open_website");
    expect(prompt).toContain("close_app()");
  });

  test("the catalogue text itself is identical across the two shapes", () => {
    // The whole point of the rewrite: any drift between these is a bug waiting
    // to happen, and the last one cost a day of the feature being unusable.
    const cut = (p: string) => p.slice(p.indexOf("<apps>"), p.indexOf("</apps>"));
    expect(cut(buildSpeakerPrompt({ ...toolMode, enabledApps: apps, availableCustomApps: custom })))
      .toBe(cut(buildSpeakerPrompt({ ...live, enabledApps: apps, availableCustomApps: custom })));
  });

  test("muted native-audio uses the tool shape (mute lifts suppression)", () => {
    const prompt = buildSpeakerPrompt({
      studentName: "Alex", persona: "", muteState: "muted",
      liveAudio: true, useDirectAudio: true,
      enabledApps: apps, permittedWebsites: sites,
    });
    expect(prompt).toContain("open_website");
  });
});
