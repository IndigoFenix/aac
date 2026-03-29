/**
 * Hook that provides a translation function aware of the student/child distinction.
 *
 * Usage:
 *   const { ts } = useStudentLabel();
 *   ts('nav.students')  // → "Students" or "Children" depending on current institute
 *   ts('header.student') // → "Student" or "Child"
 *
 * `ts` works exactly like `t` but post-processes the result through adaptStudentLabel.
 * Use it for any user-facing string that contains "student" / "תלמיד".
 */

import { useCallback } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useInstitute } from '@/hooks/useInstitute';
import { adaptStudentLabel, getStudentLabels } from '@/lib/studentLabel';

export function useStudentLabel() {
  const { t, language } = useLanguage();
  const { currentInstitute } = useInstitute();
  const instituteType = currentInstitute?.type;

  /** Translate and adapt student/child labels based on institute type */
  const ts = useCallback(
    (key: string, params?: Record<string, string | number>): string => {
      return adaptStudentLabel(t(key, params), instituteType, language);
    },
    [t, instituteType, language]
  );

  const labels = getStudentLabels(instituteType, language);

  return { ts, studentLabel: labels.singular, studentsLabel: labels.plural };
}
