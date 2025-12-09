import { useState, useEffect, createContext, useContext, ReactNode } from 'react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useAuth } from "@/hooks/useAuth";

export interface Student {
  id: string;
  name: string;
  age?: number;
  birthDate?: string;
  gender?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  data: any;
}

interface StudentContextType {
  student: Student | null;
  students: Student[];
  isReady: boolean;
  isLoading: boolean;
  selectStudent: (studentId?: string | null) => Promise<boolean>;
  refetchStudent: () => Promise<void>;
}

const AAC_USERS_QUERY_KEY = ['/api/students'];
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

  // Load list of AAC users, with react-query + in‑memory cache
  const loadStudents = async (): Promise<Student[]> => {
    const cached = queryClient.getQueryData<Student[]>(AAC_USERS_QUERY_KEY);
    if (cached) {
      setStudents(cached);
      return cached;
    }

    try {
      const response = await apiRequest('GET', '/api/students');
      const data = await response.json();

      const list: Student[] =
        data?.success && Array.isArray(data.students) ? data.students : [];

      setStudents(list);
      queryClient.setQueryData<Student[]>(AAC_USERS_QUERY_KEY, list);

      return list;
    } catch (error) {
      console.error('Get AAC Users failed:', error);
      setStudents([]);
      queryClient.setQueryData<Student[]>(AAC_USERS_QUERY_KEY, []);
      return [];
    }
  };

  // Main “switch” function: use cache for instant switching, then refresh from API
  const selectStudent = async (studentId?: string | null): Promise<boolean> => {
    // Allow clearing the current selection
    if (!studentId) {
      setStudent(null);
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('aac.currentUserId');
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

    if (typeof window !== 'undefined') {
      window.localStorage.setItem('aac.currentUserId', studentId);
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
        queryClient.setQueryData<Student[]>(AAC_USERS_QUERY_KEY, (prev) => {
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
      if (typeof window !== 'undefined') {
        storedId = window.localStorage.getItem('aac.currentUserId');
      }

      if (storedId) {
        await selectStudent(storedId);
      } else {
        const initial = users.find((u) => u.isActive) ?? users[0];
        setStudent(initial ?? null);

        if (initial && typeof window !== 'undefined') {
          window.localStorage.setItem('aac.currentUserId', initial.id);
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

  // Refresh AAC users whenever the logged-in user changes
  useEffect(() => {
    if (user) {
      checkStudentStatus();  // user logged in → load AAC users
    } else {
      // user logged out → clear state
      setStudents([]);
      setStudent(null);
    }
  }, [user]);

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
