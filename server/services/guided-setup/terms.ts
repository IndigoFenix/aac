// server/services/guided-setup/terms.ts
//
// Canonical ALL-CAPS terms for every GUIDED SETUP prompt string. One file so a
// term can never drift between step blocks (docs/PROMPT_WRITING.md: "use
// global constants to organize canonical terminology"). Never inline a term
// that lives here.

import {
  GUIDED_SETUP_TERM_BY_ACCOUNT,
  type GuidedSetupAccount,
  type GuidedSetupTerm,
} from "@shared/guided-setup";

export const GS = {
  // The person being set up. Picked per account type; "AAC USER" is allowed
  // anywhere and never replaces the account term.
  CHILD: "CHILD",
  STUDENT: "STUDENT",
  PATIENT: "PATIENT",
  AAC_USER: "AAC USER",

  // The flow and its surfaces.
  FLOW: "GUIDED SETUP",
  SIDE_PANEL: "SIDE PANEL",

  // Step names.
  STEP_BASICS: "BASIC INFO",
  STEP_ROSTER: "ROSTER",
  STEP_MEDICAL: "MEDICAL INFO",
  STEP_PROGRAM: "PROGRAM",
  STEP_AAC: "AAC SETUP",
  STEP_CONTACTS: "CONTACTS",

  // Fields and objects the AI must name exactly.
  BIRTH_DATE: "BIRTH DATE",
  COUNTRY: "COUNTRY",
  HOME_LANGUAGE: "HOME LANGUAGE",
  GUARDIAN: "GUARDIAN",
  CONSENT: "CONSENT",
  DIAGNOSIS: "DIAGNOSIS",
  ALERTS: "ALERTS",
  MEDICATIONS: "MEDICATIONS",
  GOALS: "GOALS",
  AAC_APP: "AAC APP",
  // The face photo on a person's card. Named because it is the ONE thing in
  // this flow the assistant cannot do for the user — the descriptor that makes
  // a photo recognisable is computed in the browser — so every mention has to
  // point at the button they press, in the same words, on both steps.
  PORTRAIT: "PORTRAIT",
  // Step 5's people. RELATIONSHIP is the one fact besides the name that the
  // step exists to capture, so it gets a canonical spelling like the rest.
  RELATIONSHIP: "RELATIONSHIP",
  CONTACTS_PANEL: "Contacts panel",

  // Program frameworks (shared/program-framework.ts).
  TALA: "TALA",
  US_IEP: "US IEP",
  PERSONAL: "PERSONAL",
} as const;

/** The account term as it appears in prompt text. */
export function termForAccount(account: GuidedSetupAccount): GuidedSetupTerm {
  return GUIDED_SETUP_TERM_BY_ACCOUNT[account];
}

/** The two terms the AI may use for the person, as a prompt fragment. */
export function personTerms(account: GuidedSetupAccount): string {
  return `${termForAccount(account)} or the ${GS.AAC_USER}`;
}
