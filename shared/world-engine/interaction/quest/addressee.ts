// shared/world-engine/interaction/quest/addressee.ts
//
// WHO a spoken sentence is addressed to — the one resolution the quest host's
// speak() path uses, extracted pure so the engine test suite can pin it
// without pulling the DOM/THREE-bound quest-host module.

/** The addressee stack with an explicit PREEMPTING head (multiplayer command
 *  targeting): a relayed command carries the target the SENDER resolved from
 *  its own gaze/addressed state, and that explicit choice outranks every local
 *  signal — the selected family chip (a stable eyegaze target — deliberate
 *  beats incidental), then whom you're LOOKING at, else the open conversation,
 *  else — POSSESSED — the body you ride, else the nearest creature. */
export function resolveAddressee(
  explicit: string | null | undefined,
  stack: {
    addressedFamily: string | null;
    gaze: string | null;
    convo: string | null;
    possessed: string | null;
    nearest: string | null;
  },
): string | null {
  return (
    explicit ?? stack.addressedFamily ?? stack.gaze ?? stack.convo ?? stack.possessed ?? stack.nearest
  );
}
