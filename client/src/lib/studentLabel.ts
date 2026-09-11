/**
 * Student/Child/Patient label utility
 *
 * Translation values use placeholders that are replaced based on institute type:
 *   - school (default) → Student / Students / student / students
 *   - family           → Child / Children / child / children
 *   - clinic           → Patient / Patients / patient / patients
 *
 * Supported placeholder cases (case-sensitive):
 *   {{STUDENT}}  / {{Student}}  → capitalized singular (e.g. "Student")
 *   {{student}}                  → lowercase singular   (e.g. "student")
 *   {{STUDENTS}} / {{Students}} → capitalized plural    (e.g. "Students")
 *   {{students}}                 → lowercase plural     (e.g. "students")
 *
 * Languages without case (Hebrew, Arabic, Chinese, Korean) treat all variants
 * the same. German nouns are always capitalized — lowercase placeholders still
 * yield the capitalized form.
 */

type InstituteType = 'school' | 'clinic' | 'family' | string;

interface StudentLabelMap {
  singular: string;
  plural: string;
  singularLower: string;
  pluralLower: string;
}

const LABELS: Record<string, Record<'default' | 'family' | 'clinic', StudentLabelMap>> = {
  en: {
    default: { singular: 'Student', plural: 'Students', singularLower: 'student', pluralLower: 'students' },
    family:  { singular: 'Child',   plural: 'Children', singularLower: 'child',   pluralLower: 'children' },
    clinic:  { singular: 'Patient', plural: 'Patients', singularLower: 'patient', pluralLower: 'patients' },
  },
  he: {
    default: { singular: 'תלמיד/ה', plural: 'תלמידים', singularLower: 'תלמיד/ה', pluralLower: 'תלמידים' },
    family:  { singular: 'ילד/ה',   plural: 'ילדים',   singularLower: 'ילד/ה',   pluralLower: 'ילדים' },
    clinic:  { singular: 'מטופל/ת', plural: 'מטופלים', singularLower: 'מטופל/ת', pluralLower: 'מטופלים' },
  },
  es: {
    default: { singular: 'Estudiante', plural: 'Estudiantes', singularLower: 'estudiante', pluralLower: 'estudiantes' },
    family:  { singular: 'Niño/a',     plural: 'Niños',       singularLower: 'niño/a',     pluralLower: 'niños' },
    clinic:  { singular: 'Paciente',   plural: 'Pacientes',   singularLower: 'paciente',   pluralLower: 'pacientes' },
  },
  pt: {
    default: { singular: 'Aluno/a',  plural: 'Alunos',    singularLower: 'aluno/a',  pluralLower: 'alunos' },
    family:  { singular: 'Criança',  plural: 'Crianças',  singularLower: 'criança',  pluralLower: 'crianças' },
    clinic:  { singular: 'Paciente', plural: 'Pacientes', singularLower: 'paciente', pluralLower: 'pacientes' },
  },
  fr: {
    default: { singular: 'Élève',   plural: 'Élèves',   singularLower: 'élève',   pluralLower: 'élèves' },
    family:  { singular: 'Enfant',  plural: 'Enfants',  singularLower: 'enfant',  pluralLower: 'enfants' },
    clinic:  { singular: 'Patient', plural: 'Patients', singularLower: 'patient', pluralLower: 'patients' },
  },
  ru: {
    default: { singular: 'Ученик',  plural: 'Ученики',  singularLower: 'ученик',  pluralLower: 'ученики' },
    family:  { singular: 'Ребёнок', plural: 'Дети',     singularLower: 'ребёнок', pluralLower: 'дети' },
    clinic:  { singular: 'Пациент', plural: 'Пациенты', singularLower: 'пациент', pluralLower: 'пациенты' },
  },
  de: {
    // German nouns are always capitalized — "lowercase" variants still yield the capitalized form.
    default: { singular: 'Schüler', plural: 'Schüler',   singularLower: 'Schüler', pluralLower: 'Schüler' },
    family:  { singular: 'Kind',    plural: 'Kinder',    singularLower: 'Kind',    pluralLower: 'Kinder' },
    clinic:  { singular: 'Patient', plural: 'Patienten', singularLower: 'Patient', pluralLower: 'Patienten' },
  },
  ar: {
    default: { singular: 'طالب', plural: 'طلاب',  singularLower: 'طالب', pluralLower: 'طلاب' },
    family:  { singular: 'طفل',  plural: 'أطفال', singularLower: 'طفل',  pluralLower: 'أطفال' },
    clinic:  { singular: 'مريض', plural: 'مرضى',  singularLower: 'مريض', pluralLower: 'مرضى' },
  },
  zh: {
    default: { singular: '学生', plural: '学生',   singularLower: '学生', pluralLower: '学生' },
    family:  { singular: '孩子', plural: '孩子们', singularLower: '孩子', pluralLower: '孩子们' },
    clinic:  { singular: '患者', plural: '患者',   singularLower: '患者', pluralLower: '患者' },
  },
  yue: {
    default: { singular: '學生',   plural: '學生',   singularLower: '學生',   pluralLower: '學生' },
    family:  { singular: '小朋友', plural: '小朋友', singularLower: '小朋友', pluralLower: '小朋友' },
    clinic:  { singular: '病人',   plural: '病人',   singularLower: '病人',   pluralLower: '病人' },
  },
  ko: {
    default: { singular: '학생', plural: '학생들', singularLower: '학생', pluralLower: '학생들' },
    family:  { singular: '아이', plural: '아이들', singularLower: '아이', pluralLower: '아이들' },
    clinic:  { singular: '환자', plural: '환자들', singularLower: '환자', pluralLower: '환자들' },
  },
};

function resolveKey(instituteType: InstituteType | undefined | null): 'default' | 'family' | 'clinic' {
  if (instituteType === 'family') return 'family';
  if (instituteType === 'clinic') return 'clinic';
  return 'default';
}

/**
 * Get the label map for the given institute type and language.
 */
export function getStudentLabels(
  instituteType: InstituteType | undefined | null,
  language: string = 'en'
): StudentLabelMap {
  const lang = LABELS[language] || LABELS.en;
  return lang[resolveKey(instituteType)];
}

// Module-level state: set by useStudentLabel hook so t() can access it
let _currentInstituteType: InstituteType | undefined | null = undefined;
let _currentLanguage: string = 'en';

export function setCurrentStudentContext(instituteType: InstituteType | undefined | null, language: string) {
  _currentInstituteType = instituteType;
  _currentLanguage = language;
}

/**
 * The ONLY double-brace tokens this system understands, mapped to the label
 * field each one resolves to.
 *
 * This is the single source of truth: the matching regex and the substitution
 * are both derived from it, and `scripts/scan-i18n-coverage.ts` imports it so
 * the CI check for stray `{{...}}` tokens in locale files can never drift from
 * what `adaptStudentLabel` actually replaces.
 *
 * Anything NOT listed here survives untouched and is rendered to the user with
 * its braces showing. In particular `t()` interpolation uses SINGLE braces
 * (`{name}`), so `"Reports for {{name}}"` renders as `Reports for {Sam}`.
 */
export const STUDENT_LABEL_TOKENS = {
  STUDENT: 'singular',
  Student: 'singular',
  student: 'singularLower',
  STUDENTS: 'plural',
  Students: 'plural',
  students: 'pluralLower',
} as const satisfies Record<string, keyof StudentLabelMap>;

export type StudentLabelToken = keyof typeof STUDENT_LABEL_TOKENS;

const PLACEHOLDER_RE = new RegExp(
  `\\{\\{(${Object.keys(STUDENT_LABEL_TOKENS).join('|')})\\}\\}`,
  'g'
);

/**
 * Replace {{STUDENT}}/{{Student}}/{{student}}/{{STUDENTS}}/{{Students}}/{{students}}
 * placeholders in a translated string with the appropriate term for the current
 * institute type and language.
 *
 * Can be called with explicit parameters, or uses module-level defaults
 * (set via setCurrentStudentContext) when called without them.
 */
export function adaptStudentLabel(
  text: string,
  instituteType?: InstituteType | undefined | null,
  language?: string
): string {
  if (!text || !text.includes('{{')) return text;

  const type = instituteType !== undefined ? instituteType : _currentInstituteType;
  const lang = language ?? _currentLanguage;
  const labels = getStudentLabels(type, lang);

  return text.replace(PLACEHOLDER_RE, (match, token: string) => {
    const field = STUDENT_LABEL_TOKENS[token as StudentLabelToken];
    return field ? labels[field] : match;
  });
}
