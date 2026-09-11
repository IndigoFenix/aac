// client/src/features/guided-setup/consent-branch.ts
//
// The consent gate, reduced to ONE decision.
//
// The rail used to scatter three independent booleans across its JSX —
// `canSignConsent` (family only), the roster batch button (this session's
// import only) and `needsGuardianContact` (gate `none` only). Every one of them
// could be false at once, and for the commonest institution path they were: a
// clinic that added a single student through the chat and then added a guardian
// lands on `sign_required` WITH a contact id, which no branch covered. The rail
// rendered a grey locked dot, a one-word badge and nothing else, while the
// assistant told the user to press a button that was not on screen.
//
// So the choice is made once, here, as a total function: every reachable
// (account, gate, contact) triple returns a branch, and each branch owes the
// user either a button or an explicit "nothing to do but wait". A `null` means
// the card does not apply at all (the gate is off, consent is already active,
// or no student is bound yet) — never "we had nothing to say".
//
// Pure and dependency-free on purpose. There is no jest project over
// `client/src`, so this is currently UNTESTED; keeping it free of React is what
// makes it testable the day one exists.

import type { GuidedSetupAccount, GuidedSetupGate } from '@shared/guided-setup';

/**
 * A gate a consent request can actually MOVE. `request_sent` is excluded on
 * purpose: a second link to the same guardian is not a nudge, it is two live
 * magic links for one child. `active` and `off` need nothing.
 */
export const GATE_NEEDS_REQUEST: readonly GuidedSetupGate[] = ['none', 'sign_required', 'revoked'];

/**
 * How the consent stage reads in the stepper. Display-only, and deliberately
 * coarser than `GuidedSetupGate`: the user is being told "done / your move /
 * waiting", not the name of a server enum.
 */
export type ConsentStageState = 'done' | 'attention' | 'pending';

/** `null` when the gate does not apply to this deployment at all. */
export function consentStageState(gate: GuidedSetupGate): ConsentStageState | null {
  switch (gate) {
    case 'off':
      return null;
    case 'active':
      return 'done';
    case 'request_sent':
      return 'pending';
    case 'none':
    case 'sign_required':
    case 'revoked':
      return 'attention';
  }
}

export interface ConsentBranchInput {
  account: GuidedSetupAccount;
  gate: GuidedSetupGate;
  /** The bound student, or null while step 1 has not created one yet. */
  studentId: string | null;
  /**
   * The bound student's own guardian contact, from `view.parked`. Reading the
   * BOUND row is fine; listing other students' rows is the regression the rail's
   * parked-list comment warns about.
   */
  consentContactId: string | null | undefined;
}

/**
 * What the consent card offers. One branch, always one — and every branch owes
 * the user at least one move.
 *
 * - `sign`                    family, they are the guardian → the consent wizard.
 * - `addGuardianFamily`       family with nobody on file → Contacts.
 * - `addGuardianInstitution`  institution with no reachable guardian → Contacts.
 * - `sendRequest`             institution with a guardian → email the magic link,
 *                             OR attest in person (see below).
 * - `wait`                    a link is out; a second one is not a nudge.
 *
 * `sendRequest` is the one branch with TWO moves, because the situation has
 * two: the guardian is reachable by email, and the guardian may also be sitting
 * in the room. `offersInPersonAttestation` names that rule so the rail does not
 * re-derive it from `branch.kind`.
 */
export type ConsentBranch =
  | { kind: 'sign' }
  | { kind: 'addGuardianFamily' }
  | { kind: 'addGuardianInstitution' }
  | { kind: 'sendRequest'; contactId: string }
  | { kind: 'wait' };

/** `null` = render no consent card. Otherwise a branch that owes the user something. */
export function consentBranch(input: ConsentBranchInput): ConsentBranch | null {
  const { account, gate, studentId, consentContactId } = input;

  // The gate is disabled for this deployment, consent is already signed, or
  // there is no student for it to be about yet.
  if (gate === 'off' || gate === 'active' || !studentId) return null;

  // A link is live. Nothing to press — see GATE_NEEDS_REQUEST above.
  if (gate === 'request_sent') return { kind: 'wait' };

  if (account === 'family') {
    // A family student gets a guardian contact server-side, so `sign_required`
    // is the normal landing. `none` means that auto-create did not happen —
    // a failure case, but still one with an obvious move.
    if (gate === 'sign_required' || gate === 'revoked') return { kind: 'sign' };
    return { kind: 'addGuardianFamily' };
  }

  // Institution. With a reachable guardian the move is the link; without one it
  // is the contact — and `gate` here is necessarily in GATE_NEEDS_REQUEST
  // (`off`, `active` and `request_sent` all returned above).
  if (consentContactId) return { kind: 'sendRequest', contactId: consentContactId };
  return { kind: 'addGuardianInstitution' };
}

/**
 * Whether this branch also offers the in-person clinician attestation — the
 * clinic-desk path where the guardian is physically present and the clinician
 * records the consent from their own session
 * (`POST /api/consent/students/:id/attest-in-person`).
 *
 * Only `sendRequest`, and deliberately so:
 *
 * - `sign` is the FAMILY path. That user IS the guardian, so they sign as
 *   themselves; attesting for yourself is not a thing.
 * - `addGuardian*` has nobody to attest for yet.
 * - `wait` is excluded for the same reason it offers no second link: a live
 *   magic link and a desk signature are two open paths to one consent record,
 *   and the invitation would stay redeemable afterwards. A guardian who walks
 *   in while a link is outstanding is handled by revoking the invitation first
 *   (Pending consent requests → Revoke), which returns the gate to
 *   `sign_required` and this branch.
 */
export function offersInPersonAttestation(
  branch: ConsentBranch | null,
): branch is { kind: 'sendRequest'; contactId: string } {
  return branch?.kind === 'sendRequest';
}
