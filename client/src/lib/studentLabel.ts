/**
 * Student/Child/Patient label utility
 *
 * Translation values use {{STUDENT}} and {{STUDENTS}} placeholders.
 * This module replaces them with the appropriate term based on institute type:
 *   - school (default) → Student / Students
 *   - family           → Child / Children
 *   - clinic           → Patient / Patients
 */

type InstituteType = 'school' | 'clinic' | 'family' | string;

interface StudentLabelMap {
  singular: string;
  plural: string;
}

const LABELS: Record<string, Record<'default' | 'family' | 'clinic', StudentLabelMap>> = {
  en: {
    default: { singular: 'Student', plural: 'Students' },
    family:  { singular: 'Child', plural: 'Children' },
    clinic:  { singular: 'Patient', plural: 'Patients' },
  },
  he: {
    default: { singular: 'תלמיד/ה', plural: 'תלמידים' },
    family:  { singular: 'ילד/ה', plural: 'ילדים' },
    clinic:  { singular: 'מטופל/ת', plural: 'מטופלים' },
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

/**
 * Replace {{STUDENT}} and {{STUDENTS}} placeholders in a translated string
 * with the appropriate term for the current institute type and language.
 */
export function adaptStudentLabel(
  text: string,
  instituteType: InstituteType | undefined | null,
  language: string = 'en'
): string {
  if (!text || (!text.includes('{{STUDENT}}') && !text.includes('{{STUDENTS}}'))) return text;

  const labels = getStudentLabels(instituteType, language);
  return text
    .replace(/\{\{STUDENTS\}\}/g, labels.plural)
    .replace(/\{\{STUDENT\}\}/g, labels.singular);
}
