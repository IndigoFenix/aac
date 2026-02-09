import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/home";
import { CameraProvider } from "@/components/CameraProvider";
import LoginModal from "@/components/LoginModal";
import StudentSelector from "@/components/StudentSelector";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { LanguageProvider, useLanguage } from "@/contexts/LanguageContext";
import { AppInitializationProvider } from "@/contexts/AppInitializationContext";
import { BoardsProvider } from "@/contexts/BoardsContext";
import { ConversationProvider } from "@/contexts/ConversationContext";
import { useState } from "react";

interface AuthUser {
  id: string;
  name?: string;
  email?: string;
}

interface AuthResponse {
  success: boolean;
  user: AuthUser | null;
}

function MainApp() {
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(
    () => localStorage.getItem('synapse_student_id')
  );
  const { t, isRTL, direction, language } = useLanguage();

  const { data: authData, isLoading, error, refetch } = useQuery<AuthResponse>({
    queryKey: ["/auth/user"],
    retry: false,
    staleTime: 0, // Always check fresh auth status
    gcTime: 0, // Don't cache auth data (formerly cacheTime)
  });

  const handleLoginSuccess = () => {
    refetch();
  };

  const handleLogout = () => {
    setSelectedStudentId(null);
    localStorage.removeItem('synapse_student_id');
    localStorage.removeItem('synapse_user_profile');
    // Set user to null to immediately trigger login screen, then refetch to confirm
    queryClient.setQueryData(["/auth/user"], null);
  };

  const handleStudentSelect = (studentId: string) => {
    localStorage.setItem('synapse_student_id', studentId);
    setSelectedStudentId(studentId);
  };

  const handleExitStudent = () => {
    localStorage.removeItem('synapse_student_id');
    setSelectedStudentId(null);
  };

  // Show loading while checking authentication
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center" dir={direction}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-300">{t("app.loading")}</p>
        </div>
      </div>
    );
  }

  // Step 1: Not authenticated - show login
  // Note: /auth/user returns { success: boolean, user: object|null }
  // So we need to check authData?.user, not just authData
  if (error || !authData?.user) {
    return (
      <LoginModal
        isOpen={true}
        onClose={handleLoginSuccess}
      />
    );
  }

  // Step 2: Authenticated but no student selected - show student selector
  if (!selectedStudentId) {
    return (
      <StudentSelector
        user={authData.user}
        onStudentSelect={handleStudentSelect}
        onLogout={handleLogout}
      />
    );
  }

  // Step 3: Student selected - show AAC interface with initialization
  return (
    <AppInitializationProvider>
      <CameraProvider>
        <BoardsProvider studentId={selectedStudentId}>
          <ConversationProvider studentId={selectedStudentId} language={language}>
            <Home
              studentId={selectedStudentId}
              onLogout={handleLogout}
              onExitStudent={handleExitStudent}
            />
          </ConversationProvider>
        </BoardsProvider>
      </CameraProvider>
    </AppInitializationProvider>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider defaultTheme="light">
        <LanguageProvider>
          <TooltipProvider>
            <Toaster />
            <MainApp />
          </TooltipProvider>
        </LanguageProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
