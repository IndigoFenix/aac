// server/services/access/index.ts
//
// The authorization policies, by name. See `studentAccess.ts` for the rules and
// for what deliberately lives elsewhere.
//
//   studentAccess / hasStudentAccess / requireStudentAccess
//       THE BROAD POLICY — link ∨ family-institute member ∨ school/clinic admin.
//   sharesInstituteWithStudent / assertSharesInstituteWithStudent
//       INSTITUTE OVERLAP ONLY — system admin ∨ shares an active institute.
//   administersStudentInstitute
//       Admin of one of the STUDENT's institutes (never a caller-supplied one).
//   wizardContextGrantFor / assertWizardContextAccess
//       The consent wizard's three-predicate union.

export {
  studentAccess,
  hasStudentAccess,
  requireStudentAccess,
  sharesInstituteWithStudent,
  assertSharesInstituteWithStudent,
  administersStudentInstitute,
  wizardContextGrantFor,
  assertWizardContextAccess,
  principalFromRequest,
} from "./studentAccess";

export type {
  AccessPrincipal,
  StudentAccessResult,
  StudentAccessDenialShape,
  RequireStudentAccessOptions,
  WizardContextGrant,
} from "./studentAccess";
