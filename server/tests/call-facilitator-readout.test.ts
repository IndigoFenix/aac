// A FACILITATED PRESS IS AN OFFER, NOT THE CHILD'S VOICE.
//
// A clinician who arms "Interact" on the call mirror and taps a button used to
// have that press RE-EMITTED through the student's own press pipeline: the
// student's voice said it, the server heard it, and the AI answered it as the
// student's utterance. Nobody wanted words put in the child's mouth.
//
// What it does now is exactly what the AUDIO SCAN does for one button — the
// button lights up (the yellow highlight) and is read aloud by the CLIENT-side
// TTS, announced through BoardAudioContext's `lastSpoken` so the AI tags it
// [OWN_SPEECH] and does not respond. Nothing reaches the press pipeline, the
// server, or the sentence builder's composition.
//
// The regression this pins is a WIRING one, and it is invisible in types: the
// bridges would still compile (and still ack ok) with the press handler back on
// them. So it is asserted on the SOURCE, in the same idiom as
// call-controls.test.ts — the client jest config is `testEnvironment: 'node'`
// and deliberately declines jsdom.

import { describe, it, expect } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

const HOME = "client-aac/src/pages/home.tsx";
const OVERLAY = "client-aac/src/components/CallVideoOverlay.tsx";
const BOARD_AUDIO = "client-aac/src/contexts/BoardAudioContext.tsx";
const WIRE = "shared/call/call-data-messages.ts";

describe("a facilitated press never reaches the press pipeline", () => {
  it("home hands the board bridge NO press handler", () => {
    const src = read(HOME);
    const bridge = src.slice(
      src.indexOf("<CallFacilitatorBridge"),
      src.indexOf("/>", src.indexOf("<CallFacilitatorBridge")),
    );
    expect(bridge).toContain("enabled=");
    // The student's real press handler, and any other handler, is gone.
    expect(bridge).not.toContain("handleBoardButtonClick");
    expect(bridge).not.toContain("onPress");
  });

  it("home hands the builder bridge NO press handle", () => {
    const src = read(HOME);
    const bridge = src.slice(
      src.indexOf("<CallBuilderFacilitatorBridge"),
      src.indexOf("/>", src.indexOf("<CallBuilderFacilitatorBridge")),
    );
    expect(bridge).toContain("enabled=");
    expect(bridge).not.toContain("press=");
    // The imperative handle the old wiring needed is dead and deleted with it.
    expect(src).not.toContain("facilitateBuilderPress");
    expect(src).not.toContain("builderRemoteRef");
  });

  it("the builder no longer exposes a remote press handle at all", () => {
    // A second composition path that nothing calls is the one that quietly
    // comes back.
    const builder = read("client-aac/src/components/SentenceConstructorBoard.tsx");
    expect(builder).not.toContain("BuilderRemote");
    expect(builder).not.toContain("remoteRef");
    expect(builder).not.toContain("useImperativeHandle");
  });
});

describe("both bridges light the button up and read it aloud", () => {
  const overlay = read(OVERLAY);

  it("the board bridge resolves the mirror id and calls the readout", () => {
    expect(overlay).toContain("export function CallFacilitatorBridge({ enabled }: { enabled: boolean })");
    expect(overlay).toContain("const { readout } = useBoardAudio();");
    expect(overlay).toContain('`[data-mirror-id="${CSS.escape(facilitatorPress.button.id)}"]`');
    expect(overlay).toContain("void readout(el, facilitatorPress.spokenText || facilitatorPress.button.label)");
  });

  it("the builder bridge resolves the SAME way, via formatBuilderTarget", () => {
    expect(overlay).toContain("export function CallBuilderFacilitatorBridge({ enabled }: { enabled: boolean })");
    expect(overlay).toContain("const mirrorId = formatBuilderTarget(facilitatorBuilder.target);");
    expect(overlay).toContain('`[data-mirror-id="${CSS.escape(mirrorId)}"]`');
    expect(overlay).toContain("void readout(el);");
  });

  it("a button that is no longer on screen comes back as `unavailable`", () => {
    // Both bridges. A silent drop is indistinguishable from a broken call —
    // that is the whole reason the ack exists.
    const acks = overlay.match(/reason: "unavailable"/g) ?? [];
    expect(acks.length).toBe(2);
    // …and the refusal when consent is off is still its own reason.
    const consent = overlay.match(/reason: "consent"/g) ?? [];
    expect(consent.length).toBe(2);
  });

  it("neither bridge reaches a press handler any more", () => {
    const facilitator = overlay.slice(
      overlay.indexOf("export function CallFacilitatorBridge"),
      overlay.indexOf("export function CallIndicateBridge"),
    );
    expect(facilitator).not.toContain("onPress(");
    const builder = overlay.slice(
      overlay.indexOf("export function CallBuilderFacilitatorBridge"),
      overlay.indexOf("export function CallVideoLarge"),
    );
    expect(builder).not.toContain("press(");
  });
});

describe("the readout is ONE controller, and the AI is told about it", () => {
  const boardAudio = read(BOARD_AUDIO);

  it("BoardAudioContext owns it — no second TTS and no second highlight", () => {
    expect(boardAudio).toContain("readout: (el: HTMLElement, text?: string) => Promise<void>");
    expect(boardAudio).toContain("const readout = useCallback(");
    // The scan is stopped first: two voices reading the board at once is noise.
    expect(boardAudio).toContain("stopScan();");
    expect(boardAudio).toContain("setHighlightEl(el);");
    // Cleared ONLY if the highlight is still ours — a hold-commit or a scan
    // that took it while the utterance ran owns it now.
    expect(boardAudio).toContain("setHighlightEl((cur) => (cur === el ? null : cur));");
    // Exactly one place speaks, and it is the one that announces `lastSpoken`.
    expect(boardAudio.match(/return speak\(/g)?.length).toBe(1);
  });

  it("speaking a readout announces it, which is what keeps the AI quiet", () => {
    // `lastSpoken` → DualAgentContext → the Observer as [OWN_SPEECH].
    expect(boardAudio).toContain("setLastSpoken({ text, tick: tickRef.current });");
    expect(read("client-aac/src/contexts/DualAgentContext.tsx"))
      .toContain("[OWN_SPEECH] (student voice)");
  });

  it("the element's own data-speech wins; the clinician's text is a fallback", () => {
    expect(boardAudio).toContain('speechTextOf(el) || (text ?? "").trim()');
  });
});

describe("the wire format is unchanged — older clients keep parsing", () => {
  const wire = read(WIRE);

  it("keeps the same three message kinds and their fields", () => {
    for (const k of ['k: "facilitator-press"', 'k: "facilitator-builder"', 'k: "facilitator-ack"']) {
      expect(wire).toContain(k);
    }
    expect(wire).toContain("spokenText: string;");
    expect(wire).toContain("target: BuilderTarget;");
    expect(wire).toContain('reason?: "consent" | "unavailable";');
  });

  it("still narrows all three on the way in", () => {
    expect(wire).toContain('case "facilitator-press":');
    expect(wire).toContain('case "facilitator-builder":');
    expect(wire).toContain('case "facilitator-ack":');
  });
});
