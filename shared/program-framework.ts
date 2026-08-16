// Program framework registry — the single source of truth for which
// educational/clinical framework a student's program is written under, and
// which parts of the program machinery that framework actually calls for.
//
// A framework is a slug plus a bundle of capability flags. Statutory frameworks
// ("tala", "us_iep") carry legal scaffolding — filing deadlines, placement
// statements, prior-written-consent forms, transition planning. The "personal"
// framework is for learners who are NOT in a school system at all (home-based
// AAC users, private clinic clients, adults, families): they still get a real
// program — domains, goals, objectives, services, accommodations, progress
// reports, data points, team — but none of the statutory paperwork, because no
// ministry or district is on the other end of it.
//
// A framework is NOT a compliance regime. An Israeli learner on a "personal"
// program is still covered by whatever regimes the institute's license declares
// (see shared/regime/regimes.ts). Never derive one from the other.
//
// Adding a framework = adding an entry here + a value on `programFrameworkEnum`
// in shared/schema-private.ts (then `npm run db:generate` — never hand-author
// the migration).

export type ProgramFramework = "tala" | "us_iep" | "personal";

export interface FrameworkCapabilities {
  /** A statutory filing deadline applies (TALA: Nov 15; IEP: annual review date). */
  statutoryDueDate: boolean;
  /** Least Restrictive Environment placement statement (IDEA). */
  lre: boolean;
  /** Per-domain "adverse effect on educational performance" statement (IDEA). */
  adverseEffect: boolean;
  /** Prior-written-consent forms — evaluation, placement, service provision (IDEA). */
  consentForms: boolean;
  /** Post-secondary transition plan (IDEA, from age 16). */
  transitionPlan: boolean;
  /** Statutory meeting types (annual review, re-evaluation, amendment). */
  statutoryMeetingTypes: boolean;
  /** ICF intervention level on goals — activity / function / participation (TALA). */
  interventionLevel: boolean;
  /**
   * Goal Attainment Scaling. Deliberately available under EVERY framework: GAS
   * is a clinical scoring method that TALA happens to prescribe, not a TALA
   * artifact. Listed here so the "why is this on for personal?" question has an
   * answer in one place.
   */
  gas: boolean;
}

export interface FrameworkBundle {
  slug: ProgramFramework;
  /** i18n key suffix — `t('program.framework' + labelSuffix)`, `t('student.framework' + labelSuffix)`. */
  labelSuffix: "Tala" | "Iep" | "Personal";
  /** Whether a public authority (ministry / district) is a party to this program. */
  statutory: boolean;
  /** Default country hint for new students, or null when the framework is country-neutral. */
  country: string | null;
  capabilities: FrameworkCapabilities;
}

const STATUTORY_NONE: FrameworkCapabilities = {
  statutoryDueDate: false,
  lre: false,
  adverseEffect: false,
  consentForms: false,
  transitionPlan: false,
  statutoryMeetingTypes: false,
  interventionLevel: false,
  gas: true,
};

const REGISTRY: Record<ProgramFramework, FrameworkBundle> = {
  tala: {
    slug: "tala",
    labelSuffix: "Tala",
    statutory: true,
    country: "IL",
    capabilities: {
      statutoryDueDate: true,
      lre: false,
      adverseEffect: false,
      consentForms: false,
      transitionPlan: false,
      statutoryMeetingTypes: true,
      interventionLevel: true,
      gas: true,
    },
  },
  us_iep: {
    slug: "us_iep",
    labelSuffix: "Iep",
    statutory: true,
    country: "US",
    capabilities: {
      statutoryDueDate: true,
      lre: true,
      adverseEffect: true,
      consentForms: true,
      transitionPlan: true,
      statutoryMeetingTypes: true,
      interventionLevel: false,
      gas: true,
    },
  },
  personal: {
    slug: "personal",
    labelSuffix: "Personal",
    statutory: false,
    country: null,
    capabilities: STATUTORY_NONE,
  },
};

export const PROGRAM_FRAMEWORKS: ReadonlyArray<ProgramFramework> =
  Object.keys(REGISTRY) as ProgramFramework[];

/** The framework assumed when a student/program has none recorded. */
export const DEFAULT_PROGRAM_FRAMEWORK: ProgramFramework = "personal";

/** Return the bundle for a slug, or null if the slug is unknown. */
export function getFrameworkBundle(slug: string | null | undefined): FrameworkBundle | null {
  if (!slug) return null;
  return (REGISTRY as Record<string, FrameworkBundle>)[slug] ?? null;
}

/** Coerce anything to a known framework slug, or null when unrecognized/absent. */
export function normalizeFramework(raw: string | null | undefined): ProgramFramework | null {
  return getFrameworkBundle(raw)?.slug ?? null;
}

/**
 * Capabilities for a framework. An unknown or absent framework resolves to the
 * "personal" bundle — never to a statutory one, so a missing value can never
 * silently surface US/Israeli legal paperwork on a learner who has none.
 */
export function frameworkCapabilities(slug: string | null | undefined): FrameworkCapabilities {
  return (getFrameworkBundle(slug) ?? REGISTRY[DEFAULT_PROGRAM_FRAMEWORK]).capabilities;
}

/**
 * i18n key suffix for a framework's label. Replaces the binary
 * `framework === 'tala' ? 'Tala' : 'Iep'` ternaries, which mislabel any third value.
 */
export function frameworkLabelSuffix(slug: string | null | undefined): "Tala" | "Iep" | "Personal" {
  return (getFrameworkBundle(slug) ?? REGISTRY[DEFAULT_PROGRAM_FRAMEWORK]).labelSuffix;
}

/** Whether a public authority is a party to programs under this framework. */
export function isStatutoryFramework(slug: string | null | undefined): boolean {
  return getFrameworkBundle(slug)?.statutory ?? false;
}
