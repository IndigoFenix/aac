// The AAC text box: what may appear in it, and who may put it there.
//
// The box is the one place the student reads words from. Machine context the
// client sends the AI ("User navigated to page …", "[GAME] …", "[system: …]")
// used to leak into it because the send path echoed everything it sent, minus
// one ad-hoc "[system:" prefix test. These tests pin both halves of the fix:
// the caption policy itself, and the single-writer rule that stops the next
// context string from leaking the same way.

import { readFileSync, readdirSync } from "fs";
import { join, relative } from "path";
import { fileURLToPath } from "url";
import {
  applyCaption,
  EMPTY_CAPTION,
  type CaptionState,
} from "./useAacCaption";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const AAC_SRC = join(HERE, "..");

describe("caption policy", () => {
  it("shows the AI's words and keeps one turn on one message id", () => {
    const first = applyCaption(EMPTY_CAPTION, { source: "ai", text: "Hi" }, 1000);
    const second = applyCaption(first, { source: "ai", text: "Hi there" }, 2000);
    expect(first.currentMessage).toMatchObject({ role: "assistant", content: "Hi" });
    expect(second.currentMessage).toMatchObject({ role: "assistant", content: "Hi there" });
    // Same turn — a new id would restart the display animation mid-sentence.
    expect(second.currentMessage!.id).toBe(first.currentMessage!.id);
    expect(second.currentMessage!.timestamp).toBe(first.currentMessage!.timestamp);
  });

  it("starts a new message when the AI speaks after the student", () => {
    const student = applyCaption(EMPTY_CAPTION, { source: "student", text: "more juice" }, 1000);
    const ai = applyCaption(student, { source: "ai", text: "Okay!" }, 2000);
    expect(student.currentMessage).toMatchObject({ role: "user", content: "more juice" });
    expect(ai.currentMessage).toMatchObject({ role: "assistant", content: "Okay!" });
    expect(ai.currentMessage!.id).not.toBe(student.currentMessage!.id);
  });

  it("drops the heard caption when the AI starts speaking", () => {
    const heard = applyCaption(EMPTY_CAPTION, { source: "heard", text: "Do you want juice?" });
    expect(heard.transcription).toBe("Do you want juice?");
    expect(applyCaption(heard, { source: "ai", text: "Yes" }).transcription).toBeNull();
  });

  it("blanks the AI's words on a scaffold restart without ending the turn", () => {
    const ai = applyCaption(EMPTY_CAPTION, { source: "ai", text: "scaffold" }, 1000);
    const restarted = applyCaption(ai, { source: "ai-restart" });
    expect(restarted.currentMessage).toMatchObject({ role: "assistant", content: "" });
    expect(restarted.currentMessage!.id).toBe(ai.currentMessage!.id);
  });

  it("leaves the student's words alone on a scaffold restart", () => {
    const student = applyCaption(EMPTY_CAPTION, { source: "student", text: "more juice" }, 1000);
    expect(applyCaption(student, { source: "ai-restart" })).toBe(student);
  });

  it("never inherits the previous utterance's clarity", () => {
    const low = applyCaption(EMPTY_CAPTION, {
      source: "heard",
      text: "mumble",
      confidence: "low",
      clarity: "low",
    });
    const next = applyCaption(low, { source: "heard", text: "clear as day" });
    expect(low.transcriptClarity).toBe("low");
    expect(next.transcriptClarity).toBeNull();
  });

  it("lets a routed transcript supersede the live interim", () => {
    const hearing = applyCaption(EMPTY_CAPTION, { source: "hearing", text: "do you wa" });
    expect(hearing.interimTranscription).toBe("do you wa");
    expect(applyCaption(hearing, { source: "heard", text: "Do you want juice?" }).interimTranscription).toBeNull();
  });

  it("treats blank interim text as a clear", () => {
    const hearing = applyCaption(EMPTY_CAPTION, { source: "hearing", text: "do you wa" });
    expect(applyCaption(hearing, { source: "hearing", text: "   " }).interimTranscription).toBeNull();
    expect(applyCaption(hearing, { source: "hearing", text: null }).interimTranscription).toBeNull();
  });

  it("clears only the heard line when the student starts replying", () => {
    let s: CaptionState = applyCaption(EMPTY_CAPTION, { source: "ai", text: "Hello" }, 1000);
    s = applyCaption(s, { source: "heard", text: "Do you want juice?" });
    const replying = applyCaption(s, { source: "clear", scope: "heard" });
    expect(replying.transcription).toBeNull();
    expect(replying.currentMessage).toMatchObject({ content: "Hello" });
  });

  it("wipes everything on session teardown", () => {
    let s: CaptionState = applyCaption(EMPTY_CAPTION, { source: "ai", text: "Hello" }, 1000);
    s = applyCaption(s, { source: "heard", text: "Do you want juice?", clarity: "high" });
    s = applyCaption(s, { source: "hearing", text: "and th" });
    expect(applyCaption(s, { source: "clear" })).toEqual(EMPTY_CAPTION);
  });
});

// ---------------------------------------------------------------------------
// Single-writer guard
// ---------------------------------------------------------------------------
// The policy above is only worth anything if it is the ONLY way into the box.
// This walks the AAC client source and fails if anything outside
// useAacCaption.ts holds its own copy of caption state — which is exactly how
// "User navigated to page …" reached the student in the first place.

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      sourceFiles(full, out);
    } else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

describe("the AAC text box has one writer", () => {
  const CAPTION_STATE = [
    "setCurrentMessage",
    "setTranscription",
    "setInterimTranscription",
    "setTranscriptConfidence",
    "setTranscriptClarity",
  ];

  it("declares caption state only in useAacCaption", () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(AAC_SRC)) {
      const rel = relative(AAC_SRC, file).replace(/\\/g, "/");
      // The legacy single-agent ConversationContext runs its own chat log and
      // is not wired to the live box (home.tsx renders it only when the
      // dual-agent system is switched off).
      if (rel === "hooks/useAacCaption.ts" || rel === "contexts/ConversationContext.tsx") continue;
      const src = readFileSync(file, "utf8");
      for (const setter of CAPTION_STATE) {
        if (src.includes(`${setter}(`)) offenders.push(`${rel} → ${setter}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it("does not echo outbound messages to the AI back into the box", () => {
    const src = readFileSync(join(AAC_SRC, "hooks/useLiveSession.ts"), "utf8");
    const sendMessage = src.slice(src.indexOf("const sendMessage = useCallback"));
    const body = sendMessage.slice(0, sendMessage.indexOf("}, [wsSend"));
    // A caption may only be raised here when the caller says the text IS the
    // student's own words. Anything else — page navigation, game narration,
    // avatar taps — travels this same channel and must stay unseen.
    const captionCalls = body.match(/showCaption\(/g) ?? [];
    expect(captionCalls).toHaveLength(1);
    expect(body).toContain('opts?.caption === "student"');
  });
});
