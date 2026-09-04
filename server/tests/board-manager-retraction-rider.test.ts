// The `misidentified` retraction rider, as the BOARD MANAGER sees it.
//
// `flushContextUpdates` (agent-coordinator) appends an explicit [RETRACTION …]
// rider to a misidentified update before it reaches the Speaker and the
// conversation log. The Board Manager does NOT read that string: it renders
// its own `<recent_events>` from the raw event, so until now a retraction
// arrived there as a plain "[CONTEXT] misidentified: X — …" line with nothing
// telling the model to stop using the name. The board kept `target: "X"` and
// the "היי X" greeting button, and every subsequent press carried the false
// identity forward — the exact tail of the Sept 3 sister-misidentification
// incident (planning-docs/aac-presence-ledger.md §9 item 2).
import { renderEventLine } from "../services/dual-agent/prompts/board-manager";
import type { ContextUpdateEvent } from "../services/dual-agent/agent-events";

const update = (
  updateType: ContextUpdateEvent["updateType"],
  key: string,
  description: string,
): ContextUpdateEvent => ({
  type: "context_update",
  source: "observer",
  timestamp: 1_000,
  updateType,
  key,
  description,
});

describe("Board Manager <recent_events> — context_update", () => {
  it("carries the retraction rider on a misidentified update", () => {
    const line = renderEventLine(update("misidentified", "Ofek", "It was the student herself."));
    expect(line).toContain("[CONTEXT] misidentified: Ofek — It was the student herself.");
    expect(line).toContain("[RETRACTION —");
    expect(line).toContain("Treat them as NOT present");
  });

  // The rider must be BYTE-IDENTICAL to the coordinator's, so the Speaker,
  // the log and the board are all reacting to one string.
  it("uses the same rider text the coordinator sends the Speaker and the log", () => {
    const line = renderEventLine(update("misidentified", "Ofek", "not here"));
    expect(line).toContain(
      "[RETRACTION — earlier reports of this person were a misidentification. " +
      "Treat them as NOT present; do not record their presence, and strike any " +
      "note or summary line that claims it.]",
    );
  });

  // Riding every context line would train the model to skim past it.
  it("leaves ordinary context updates untouched", () => {
    const line = renderEventLine(update("new_person", "someone nearby", "an adult woman with dark hair"));
    expect(line).toBe("[CONTEXT] new_person: someone nearby — an adult woman with dark hair");
    expect(line).not.toContain("RETRACTION");
  });

  it("still renders the relevance suffix on a non-retraction update", () => {
    const ev = update("new_object", "cup", "a red cup on the table");
    ev.relevance = "builder-candidate";
    expect(renderEventLine(ev)).toBe(
      "[CONTEXT] new_object: cup — a red cup on the table (relevance: builder-candidate)",
    );
  });
});
