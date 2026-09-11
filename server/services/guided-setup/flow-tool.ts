// server/services/guided-setup/flow-tool.ts
//
// The `guidedSetup` host tool: flow CONTROL only. Data still goes through
// manageMemory over the memory-schema tree — this tool never writes a student,
// a report or a program (memory: feedback_ai_edits_via_memory_schema).
//
// The description says HOW (arguments, what comes back). WHEN to call it is
// the system-prompt block's job (docs/PROMPT_WRITING.md — do not duplicate).

import {
  GUIDED_SETUP_SKIPPABLE_STEPS,
  GUIDED_SETUP_TOOL_ACTIONS,
  GUIDED_SETUP_TOOL_NAME,
  type GuidedSetupConsentChannel,
} from "@shared/guided-setup";
import type { GPTTool } from "../chat/gpt.js";

/**
 * Steps `skip` accepts. `basics` is never skippable.
 *
 * Derived from the shared step order, not re-typed: a hand-kept copy here and
 * another in the REST controller is how step 5 ends up offered by the tool and
 * rejected by the endpoint.
 */
const SKIPPABLE_STEPS = GUIDED_SETUP_SKIPPABLE_STEPS;

/** Channels a consent request can go out on. */
const CONSENT_CHANNELS: readonly GuidedSetupConsentChannel[] = ["email", "sms"];

export const guidedSetupTool: GPTTool = {
  type: "function",
  function: {
    name: GUIDED_SETUP_TOOL_NAME,
    description:
      "Control the GUIDED SETUP flow. Returns the new flow view as JSON: " +
      "{ step, steps[{id,status,checklist}], gate, panel, refused? }. " +
      "Actions: " +
      "status = re-read the checklist without changing anything; " +
      "advance = finish the current step and move on; " +
      "skip = mark a step skipped (pass `step`, or omit for the current one); " +
      "back = discuss an earlier step (nothing is undone); " +
      "activateProgram = activate the newest program and its draft goals and objectives; " +
      "setAacUser = record whether this person uses the AAC app (pass `value`); " +
      "requestConsent = email or text a consent link to a guardian (pass `contactId` and `channel`); " +
      "proposeRoster = hand back the rows you read from an uploaded roster (pass `rows`) for the user " +
      "to review and confirm in the side panel — it creates nobody. " +
      "A rejected action comes back as refused:{action,reason} and the flow does NOT move — " +
      "read the reason and the checklist, tell the user what is missing, do not retry blindly.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [...GUIDED_SETUP_TOOL_ACTIONS],
          description: "Which flow control to apply.",
        },
        step: {
          type: "string",
          enum: [...SKIPPABLE_STEPS],
          description: "Step to skip. Only used with action=skip; defaults to the current step.",
        },
        value: {
          type: "boolean",
          description: "action=setAacUser: true when this person will use the AAC app.",
        },
        contactId: {
          type: "string",
          description: "action=requestConsent: id of the guardian contact to send the link to.",
        },
        channel: {
          type: "string",
          enum: [...CONSENT_CHANNELS],
          description: "action=requestConsent: send to the contact's email or phone.",
        },
        rows: {
          type: "array",
          description:
            "action=proposeRoster: the rows you read from the uploaded roster, one per person. " +
            "Use null for anything you cannot read; never guess a name or a date.",
          items: {
            type: "object",
            properties: {
              firstName: { type: "string" },
              lastName: { type: "string" },
              birthDate: { type: "string", description: "As printed. The server normalises it." },
              gender: { type: "string" },
              grade: { type: "string" },
              idNumber: { type: "string", description: "The school's own number, never a national ID." },
              guardianName: { type: "string" },
              guardianEmail: { type: "string" },
              guardianPhone: { type: "string" },
            },
            additionalProperties: false,
          },
        },
      },
      required: ["action"],
      additionalProperties: false,
    },
  },
};
