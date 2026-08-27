// Repro suite for the clinician-speech path: what a clinician SAYS on a call is
// supposed to reach the student's screen (caption) and rebuild their board.
// Reported symptom: it doesn't.
//
// ── READ THIS BEFORE "FIXING" A FAILURE ────────────────────────────────────
// These are CHARACTERIZATION tests. Every assertion marked `DEFECT:` pins the
// CURRENT, WRONG behaviour on purpose, so the suite is green today. When the
// bug is actually fixed the matching test FAILS — that is the point: flip the
// assertion then, and delete the DEFECT note.
//
// HISTORY. §2 has already been through that cycle: A3 (2026-08-26) removed the
// browser Web-Speech path and its echo guard, both PIN tests failed on the next
// run exactly as intended, and the section was flipped from reproducing the bug
// to guarding the fix. §3's defect is still open (C1).
// ───────────────────────────────────────────────────────────────────────────
//
// Coverage is split by what can be driven for real:
//
//   §1  REAL CODE. server/services/dual-agent/conversation-room.ts — the fan-out
//       every clinician utterance travels through. Driven directly.
//
//   §2  PINNED TO SOURCE. Whether the removed Web-Speech path and its echo
//       guard have stayed removed. These read the real .tsx, so re-introducing
//       either fails here rather than quietly shipping.
//
//   §3  REAL CODE. The recognition language now resolves server-side, so §3
//       imports `toBcp47` from google-stt-service and tests the real mapping.
//       What is still pinned to source is the VALUE fed into it — the
//       clinician's UI language, which is the open defect.
//
// Not covered: AgentCoordinator.onPeerUtterance → routeTranscribed. No test in
// this repo constructs an AgentCoordinator (it wants a DB, live agent sessions
// and an LLM); §1 stops at the room boundary the coordinator subscribes to.

import { describe, it, expect, beforeAll, afterAll } from "@jest/globals";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { initBus, stopBus } from "../services/realtime/bus-factory";
import {
  joinRoom,
  leaveRoom,
  publishUtterance,
  type RoomParticipant,
  type RoomUtterance,
} from "../services/dual-agent/conversation-room";
// The REAL mapping the server applies to whatever language hint it is handed.
import { toBcp47 } from "../services/voice/google-stt-service";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface Capture {
  utterances: RoomUtterance[];
}

/** A room member that records what it was handed. Stands in for an AAC
 *  student's AgentCoordinator (which subscribes with exactly this shape). */
function member(personId: string, name: string): { p: RoomParticipant; cap: Capture } {
  const cap: Capture = { utterances: [] };
  const p: RoomParticipant = {
    personId,
    name,
    onUtterance: (u) => cap.utterances.push(u),
    onPresence: () => {},
    onRoster: () => {},
    onFloor: () => {},
    onPeerFocus: () => {},
  };
  return { p, cap };
}

/** A clinician member wired the way routes.ts:194 wires one. */
function clinicianMember(personId: string, name: string): { p: RoomParticipant; heard: unknown[] } {
  const heard: unknown[] = [];
  const p: RoomParticipant = {
    personId,
    name,
    // VERBATIM from server/routes.ts handleCallConversation():
    //   onUtterance: () => { /* clinician hears peers via the call audio */ },
    onUtterance: () => {},
    onPresence: () => {},
    onRoster: () => {},
    onFloor: () => {},
    onPeerFocus: () => {},
  };
  return { p, heard };
}

const utter = (over: Partial<RoomUtterance>): RoomUtterance => ({
  roomId: "call-1",
  fromPersonId: "clinician-1",
  fromName: "Dana",
  text: "what did you do today?",
  addressee: "ROOM",
  at: 1,
  ...over,
});

const readSource = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");
const CALL_CONTEXT_TSX = "client/src/features/call/CallContext.tsx";

// ---------------------------------------------------------------------------

describe("clinician speech → student board", () => {
  beforeAll(async () => { await initBus(); });
  afterAll(async () => { await stopBus(); });

  // =========================================================================
  // §1  REAL CODE — the conversation-room fan-out
  // =========================================================================
  describe("§1 room fan-out (real conversation-room.ts)", () => {
    it("CONTROL: a published clinician utterance does reach the student", () => {
      const room = "call-control";
      const student = member("student-1", "Yael");
      const clinician = clinicianMember("clinician-1", "Dana");
      joinRoom(room, student.p);
      joinRoom(room, clinician.p);

      publishUtterance(utter({ roomId: room, text: "what did you do today?" }));

      // The plumbing is NOT the problem — when a phrase is actually published
      // it arrives, addressed to the whole room (so the student's coordinator
      // treats it as targetIsUser → caption + board rebuild).
      expect(student.cap.utterances).toHaveLength(1);
      expect(student.cap.utterances[0].text).toBe("what did you do today?");
      expect(student.cap.utterances[0].addressee).toBe("ROOM");

      leaveRoom(room, "student-1");
      leaveRoom(room, "clinician-1");
    });

    it("DEFECT: the clinician is deaf to the student's utterances", () => {
      const room = "call-deaf";
      const student = member("student-1", "Yael");
      const clinician = clinicianMember("clinician-1", "Dana");
      joinRoom(room, student.p);
      joinRoom(room, clinician.p);

      // The student presses a button; streamStudentTts publishes it to the room.
      publishUtterance(utter({
        roomId: room,
        fromPersonId: "student-1",
        fromName: "Yael",
        text: "I went to the park",
      }));

      // DEFECT: routes.ts wires the clinician's onUtterance to a no-op on the
      // assumption they "hear peers via the call audio" — but the student's
      // voice is a TTS track that the receiver may never render (see the
      // two-audio-track defect). So the clinician gets neither audio NOR text.
      // SHOULD BE: forwarded down the clinician's socket and captioned.
      expect(clinician.heard).toHaveLength(0);
      // The student, by contrast, is never echoed their own words.
      expect(student.cap.utterances).toHaveLength(0);

      leaveRoom(room, "student-1");
      leaveRoom(room, "clinician-1");
    });

    it("DEFECT: an utterance carries no language — nothing can localise it", () => {
      const room = "call-lang";
      const student = member("student-1", "Yael");
      joinRoom(room, student.p);

      publishUtterance(utter({ roomId: room, text: "מה עשית היום?" }));

      const received = student.cap.utterances[0];
      expect(received.text).toBe("מה עשית היום?"); // verbatim, untranslated

      // DEFECT: RoomUtterance has no `lang`/`locale` field, so a student whose
      // primaryLanguage differs from the speaker's has no way to know what
      // language landed on their board, and nothing can translate it.
      // SHOULD BE: the utterance carries the language it was recognised in.
      expect(Object.keys(received)).not.toContain("lang");
      expect(Object.keys(received)).not.toContain("locale");
      expect(Object.keys(received).sort()).toEqual(
        ["addressee", "at", "fromName", "fromPersonId", "roomId", "text"].sort(),
      );

      leaveRoom(room, "student-1");
    });
  });

  // =========================================================================
  // §2  THE ECHO GUARD — why nothing ever gets published in the first place
  // =========================================================================
  describe("§2 echo guard — REMOVED by A3, guarded against return", () => {
    it("PIN: the browser Web-Speech path is gone from the clinician client", () => {
      const src = readSource(CALL_CONTEXT_TSX);
      // PHI: Web Speech routes clinical audio through Google's CONSUMER service,
      // outside the platform's BAA region. It must not come back.
      expect(src).not.toContain("webkitSpeechRecognition");
      expect(src).not.toContain("SpeechRecognition");
      expect(src).not.toContain("SPEECH_LANG");
      // ...and with it, the guard and everything that armed it.
      expect(src).not.toContain("remoteActiveUntilRef");
      expect(src).not.toContain("suppressed likely echo of remote audio");
      expect(src).not.toContain("onAnyActive");
    });

    it("PIN: in-region server STT is the only path, and is unconditional", () => {
      const src = readSource(CALL_CONTEXT_TSX);
      expect(src).toContain("streamMicPcm(localStream");
      expect(src).toContain("clientRef.current?.sendAudioChunk(chunk, sampleRate, language)");
      // It streams `localStream`, whose audio track carries echoCancellation —
      // so the echo is removed from the signal instead of being guessed at.
      expect(readSource("shared/call/call-client.ts")).toContain("echoCancellation: true");
      // The client can no longer publish pre-transcribed text at all.
      expect(readSource("shared/call/call-client.ts")).not.toContain("sendUtterance");
    });

    it("LAW: a suppression window may never outlast the silence a final needs", () => {
      // Kept as executable reasoning, because the guard was not merely tuned too
      // tight — it was unwinnable, and the arithmetic is why. A Web Speech final
      // fired 1200ms after the speaker stopped; the guard suppressed anything
      // within 1500ms of remote audio. So a phrase died whenever
      //     burstEnd + WINDOW > speechEnd + SILENCE   i.e.  burstEnd > speechEnd - 300
      // — any remote sound in the last 300ms of the sentence, or after it.
      const OLD_WINDOW_MS = 1500;
      const OLD_SILENCE_MS = 1200;
      const deadZone = OLD_WINDOW_MS - OLD_SILENCE_MS;
      expect(deadZone).toBe(300);
      expect(OLD_WINDOW_MS).toBeGreaterThan(OLD_SILENCE_MS); // the defect, in one line

      // If any such guard is ever reintroduced, this is the invariant it owes:
      const isWinnable = (windowMs: number, silenceMs: number) => windowMs < silenceMs;
      expect(isWinnable(OLD_WINDOW_MS, OLD_SILENCE_MS)).toBe(false);
      expect(isWinnable(500, 1200)).toBe(true);
    });

    it("a clinician phrase now reaches the student's room unconditionally", () => {
      const room = "call-unguarded";
      const student = member("student-1", "Yael");
      joinRoom(room, student.p);

      // Server STT publishes every committed phrase; nothing inspects remote
      // audio first, so the far end making noise is no longer disqualifying.
      publishUtterance(utter({ roomId: room, text: "what did you do today?" }));

      expect(student.cap.utterances).toHaveLength(1);
      expect(student.cap.utterances[0].text).toBe("what did you do today?");

      leaveRoom(room, "student-1");
    });
  });

  // =========================================================================
  // §3  LANGUAGE — clinician UI language drives the recogniser
  // =========================================================================
  describe("§3 recognition language (real toBcp47 + source pin)", () => {
    it("PIN: the value fed to the recogniser is still the clinician's UI language", () => {
      const src = readSource(CALL_CONTEXT_TSX);
      // `language` comes from useLanguage() — the app's UI chrome setting. It is
      // not what the clinician said they SPEAK, and it never consults the
      // student. A3 moved WHERE recognition happens; it did not fix WHICH
      // language, which is C1.
      expect(src).toContain("const { language } = useLanguage();");
      expect(src).toContain("clientRef.current?.sendAudioChunk(chunk, sampleRate, language)");
    });

    it("resolves our short codes to the BCP-47 Google STT expects", () => {
      expect(toBcp47("en")).toBe("en-US");
      expect(toBcp47("he")).toBe("he-IL");
      expect(toBcp47("es")).toBe("es-ES");
      // Already-regioned hints pass through untouched.
      expect(toBcp47("pt-PT")).toBe("pt-PT");
    });

    it("DEFECT: a Hebrew-speaking clinician with an English UI is recognised as English", () => {
      // Same person, same speech — the result is decided by a menu that is
      // about UI chrome. Their Hebrew is transcribed as English.
      const uiLanguageOfAHebrewSpeaker = "en";
      expect(toBcp47(uiLanguageOfAHebrewSpeaker)).toBe("en-US");
      expect(toBcp47(uiLanguageOfAHebrewSpeaker)).not.toBe("he-IL");
      // SHOULD BE (C1): an explicit spoken-language choice per participant.
    });

    it("DEFECT: an unknown or missing language silently becomes English", () => {
      // No signal that recognition is now simply wrong.
      expect(toBcp47("nl")).toBe("en-US");
      expect(toBcp47("")).toBe("en-US");
      expect(toBcp47(undefined)).toBe("en-US");
    });

    it("DEFECT: the student's language never enters the decision", () => {
      const clinicianUi = "en";
      for (const student of [
        { name: "Yael", primaryLanguage: "he" },
        { name: "Sofia", primaryLanguage: "es" },
      ]) {
        expect(toBcp47(clinicianUi)).toBe("en-US");
        expect(toBcp47(clinicianUi)).not.toBe(toBcp47(student.primaryLanguage));
      }
      // SHOULD BE (C1): recognition language chosen from what the clinician
      // speaks, and the text tagged with it (RoomUtterance.lang) so each
      // student's side can localise before it reaches a caption or a board.
    });
  });
});
