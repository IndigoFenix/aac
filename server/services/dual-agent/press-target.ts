// server/services/dual-agent/press-target.ts
//
// Pure routing decision for a SENTENCE BUTTON press: who is the press
// addressed to, and should the Speaker respond to it?
//
// A button press is functionally a USER statement; the press is just the
// mechanism. The Speaker only replies when the statement is addressed to the
// AI (the DEVICE). The press itself carries no target, so the target is
// inherited from the loaded board — which defaults to "DEVICE" whenever the
// BoardManager never named an interlocutor.
//
// That default is the trap in FACILITATOR mode: the user is talking to another
// PERSON, but a target-less board makes every press look like "[USER to YOU]",
// so the Speaker replies — the opposite of what facilitator mode is for ("the
// board does the talking; Speaker stays quiet unless explicitly addressed").
// When no explicit target was given we therefore treat a facilitator press as
// an aside to the person nearby: the Speaker gets context only. An explicit
// non-device target already takes the quiet path; an explicit DEVICE target
// (the user deliberately turned to the AI) still reaches the Speaker.

import { isDeviceTarget, PARTY_DEVICE } from "./speech-party";

export interface PressRoutingInput {
  /** Explicit target carried on the press event, if any (usually undefined
   *  for client presses; synthetic presses may set it). */
  eventTarget?: string;
  /** Target of the currently-loaded board. Defaults to "DEVICE". */
  boardTarget: string;
  /** Current AI behavioral mode. */
  mode: "companion" | "facilitator";
  /** True while a social-training peer session is active (keeps its own path). */
  socialPeer: boolean;
  /** Known AI name(s) for device-target matching. */
  aiNames?: (string | undefined)[];
}

export interface PressRouting {
  /** Resolved target party string. */
  target: string;
  /** Whether the press is addressed to the AI — i.e. the Speaker should reply. */
  toDevice: boolean;
  /** Label for the rendered "[USER to <label>]" tag. */
  targetLabel: string;
  /** True when a facilitator press with no explicit target is treated as an
   *  aside to the person nearby (Speaker stays quiet). */
  facilitatorAside: boolean;
}

export function resolvePressRouting(input: PressRoutingInput): PressRouting {
  const target = input.eventTarget ?? input.boardTarget ?? PARTY_DEVICE;
  const hasExplicitTarget =
    input.eventTarget !== undefined || input.boardTarget !== PARTY_DEVICE;
  const facilitatorAside =
    input.mode === "facilitator" && !input.socialPeer && !hasExplicitTarget;
  const toDevice = !facilitatorAside && isDeviceTarget(target, ...(input.aiNames ?? []));
  const targetLabel = facilitatorAside ? "someone nearby" : toDevice ? "YOU" : target;
  return { target, toDevice, targetLabel, facilitatorAside };
}
