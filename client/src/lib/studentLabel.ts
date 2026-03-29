/**
 * Student/Child label utility
 *
 * Returns context-appropriate labels for "student" based on the institute type.
 * For family-type institutes, "student" becomes "child".
 * This is a centralized function so the logic can be updated later
 * (e.g., per-institute custom labels, or additional institute types).
 */

type InstituteType = 'school' | 'clinic' | 'family' | string;

interface StudentLabelMap {
  /** Singular: "Student" or "Child" */
  singular: string;
  /** Plural: "Students" or "Children" */
  plural: string;
}

const LABELS: Record<string, Record<'default' | 'family', StudentLabelMap>> = {
  en: {
    default: { singular: 'Student', plural: 'Students' },
    family:  { singular: 'Child', plural: 'Children' },
  },
  he: {
    default: { singular: 'תלמיד/ה', plural: 'תלמידים' },
    family:  { singular: 'ילד/ה', plural: 'ילדים' },
  },
};

/**
 * Get the label map for the given institute type and language.
 */
export function getStudentLabels(
  instituteType: InstituteType | undefined | null,
  language: string = 'en'
): StudentLabelMap {
  const lang = LABELS[language] || LABELS.en;
  return instituteType === 'family' ? lang.family : lang.default;
}

/**
 * Replace "Student"/"Students" (case-insensitive) in a translated string
 * with the appropriate label for the current institute type.
 */
export function adaptStudentLabel(
  text: string,
  instituteType: InstituteType | undefined | null,
  language: string = 'en'
): string {
  if (!text || instituteType !== 'family') return text;

  const labels = getStudentLabels(instituteType, language);
  const defaults = getStudentLabels(null, language);

  // Replace plural first (longer match) then singular
  let result = text;
  result = result.replace(new RegExp(defaults.plural, 'gi'), labels.plural);
  result = result.replace(new RegExp(defaults.singular, 'gi'), labels.singular);
  return result;
}
