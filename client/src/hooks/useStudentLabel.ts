/**
 * Hook that provides a translation function aware of the student/child/patient distinction.
 *
 * Also keeps the module-level student context in sync so that `t()` can
 * automatically resolve {{STUDENT}}/{{STUDENTS}} placeholders even without `ts()`.
 */

import React, { useCallback, useEffect } from 'react';
import { useLanguage } from '@/contexts/LanguageContext';
import { useInstitute } from '@/hooks/useInstitute';
import { adaptStudentLabel, getStudentLabels, setCurrentStudentContext } from '@/lib/studentLabel';

export function useStudentLabel() {
  const { t, language } = useLanguage();
  const { currentInstitute } = useInstitute();
  const instituteType = currentInstitute?.type;

  // Keep the module-level context in sync so adaptStudentLabel works globally
  useEffect(() => {
    setCurrentStudentContext(instituteType, language);
  }, [instituteType, language]);

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

/**
 * Invisible component that keeps the module-level student label context in sync.
 * Mount once inside InstituteProvider.
 */
export function StudentLabelSync() {
  useStudentLabel(); // triggers the useEffect that calls setCurrentStudentContext
  return null;
}
