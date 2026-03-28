import { useState, useEffect, useRef, createContext, useContext, ReactNode } from 'react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useAuth } from "@/hooks/useAuth";
import { useInstitute } from "@/hooks/useInstitute";
import { Student } from '@shared/schema';

interface StudentContextType {
  student: Student | null;
  students: Student[];
  isReady: boolean;
  isLoading: boolean;
  selectStudent: (studentId?: string | null) => Promise<boolean>;
  refetchStudent: () => Promise<void>;
}

const studentsQueryKey = (instituteId?: string) => ['/api/students', { instituteId }];
const studentDetailQueryKey = (id: string) => ['/api/students', id];

const StudentContext = createContext<StudentContextType | null>(null);

export const useStudent = () => {
  const context = useContext(StudentContext);
  if (!context) {
    throw new Error('useStudent must be used within an StudentProvider');
  }
  return context;
};

export const StudentProvider = ({ children }: { children: ReactNode }) => {
  const [student, setStudent] = useState<Student | null>(null);
  const [students, setStudents] = useState<Student[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { user } = useAuth();
  const { currentInstitute } = useInstitute();
  const prevInstituteIdRef = useRef<string | null | undefined>(undefined);

  const currentInstituteId = currentInstitute?.id ?? null;
  const currentQueryKey = studentsQueryKey(currentInstituteId ?? undefined);

  // Load list of students scoped to the selected institute
  const loadStudents = async (): Promise<Student[]> => {
    if (!currentInstituteId) {
      setStudents([]);
      return [];
    }

    const cached = queryClient.getQueryData<Student[]>(currentQueryKey);
    if (cached) {
      setStudents(cached);
      return cached;
    }

    try {
      const response = await apiRequest('GET', `/api/students?instituteId=${currentInstituteId}`);
      const data = await response.json();

      const list: Student[] =
        data?.success && Array.isArray(data.students) ? data.students : [];

      setStudents(list);
      queryClient.setQueryData<Student[]>(currentQueryKey, list);

      return list;
    } catch (error) {
      console.error('Get AAC Users failed:', error);
      setStudents([]);
      queryClient.setQueryData<Student[]>(currentQueryKey, []);
      return [];
    }
  };

  // localStorage key scoped to the current user
  const storageKey = user ? `aac.${user.id}.currentStudentId` : null;

  // Main “switch” function: use cache for instant switching, then refresh from API
  const selectStudent = async (studentId?: string | null): Promise<boolean> => {
    // Allow clearing the current selection
    if (!studentId) {
      setStudent(null);
      if (typeof window !== 'undefined' && storageKey) {
        window.localStorage.removeItem(storageKey);
      }
      return true;
    }

    // Optimistic: use any cached data so switching feels instant
    const cachedDetail = queryClient.getQueryData<Student>(
      studentDetailQueryKey(studentId)
    );
    const cachedFromList = students.find((u) => u.id === studentId);
    const optimisticUser = cachedDetail ?? cachedFromList;

    if (optimisticUser) {
      setStudent(optimisticUser);
    }

    if (typeof window !== 'undefined' && storageKey) {
      window.localStorage.setItem(storageKey, studentId);
    }

    // Always hit the API to refresh on selection
    try {
      const response = await apiRequest('GET', `/api/students/${studentId}`);
      const data = await response.json();

      if (data?.success && data.student) {
        const fresh: Student = data.student;

        if (fresh.id === student?.id) {
          setStudent(fresh);
        }

        // Keep the full list in sync
        setStudents((prev) => {
          const idx = prev.findIndex((u) => u.id === fresh.id);
          if (idx === -1) return [...prev, fresh];
          const next = [...prev];
          next[idx] = fresh;
          return next;
        });

        // Update react‑query caches
        queryClient.setQueryData<Student>(studentDetailQueryKey(studentId), fresh);
        queryClient.setQueryData<Student[]>(currentQueryKey, (prev) => {
          if (!prev) return [fresh];
          const idx = prev.findIndex((u) => u.id === fresh.id);
          if (idx === -1) return [...prev, fresh];
          const next = [...prev];
          next[idx] = fresh;
          return next;
        });

        return true;
      }

      return false;
    } catch (error) {
      console.error('Get AAC User failed:', error);
      return false;
    }
  };

  // Initial bootstrapping of AAC users + selected user
  const checkStudentStatus = async () => {
    setIsLoading(true);

    try {
      const users = await loadStudents();

      if (!users.length) {
        setStudent(null);
        return;
      }

      let storedId: string | null = null;
      if (typeof window !== 'undefined' && storageKey) {
        storedId = window.localStorage.getItem(storageKey);
      }

      if (storedId && users.some((u) => u.id === storedId)) {
        await selectStudent(storedId);
      } else {
        const initial = users.find((u) => u.isActive) ?? users[0];
        setStudent(initial ?? null);

        if (initial && typeof window !== 'undefined' && storageKey) {
          window.localStorage.setItem(storageKey, initial.id);
        }
      }
    } catch (error) {
      console.error('AAC User status check failed:', error);
      setStudent(null);
    } finally {
      setIsLoading(false);
    }
  };

  const refetchStudent = async () => {
    await checkStudentStatus();
  };

  // Refresh AAC users whenever the logged-in user or selected institute changes
  useEffect(() => {
    if (!user) {
      // user logged out → clear state
      setStudents([]);
      setStudent(null);
      prevInstituteIdRef.current = undefined;
      return;
    }

    const instituteChanged = prevInstituteIdRef.current !== undefined
      && prevInstituteIdRef.current !== currentInstituteId;
    prevInstituteIdRef.current = currentInstituteId;

    if (!currentInstituteId) {
      // No institute selected → clear students
      setStudents([]);
      setStudent(null);
      setIsLoading(false);
      return;
    }

    if (instituteChanged) {
      // Institute changed → clear current selection and reload
      setStudent(null);
      if (typeof window !== 'undefined' && storageKey) {
        window.localStorage.removeItem(storageKey);
      }
    }

    checkStudentStatus();
  }, [user, currentInstituteId]);

  const contextValue: StudentContextType = {
    student,
    students,
    isLoading,
    isReady: !isLoading && !!student,
    selectStudent,
    refetchStudent,
  };

  return (
    <StudentContext.Provider value={contextValue}>
      {children}
    </StudentContext.Provider>
  );
};
