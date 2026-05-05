import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/home";
import GameEmbed from "@/components/games/GameEmbed";
import { CameraProvider } from "@/components/CameraProvider";
import LoginModal from "@/components/LoginModal";
import StudentSelector from "@/components/StudentSelector";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { LanguageProvider, useLanguage } from "@/contexts/LanguageContext";
import { CookieConsent } from "@/components/CookieConsent";
import { AppInitializationProvider } from "@/contexts/AppInitializationContext";
import { BoardsProvider } from "@/contexts/BoardsContext";
import { ConversationProvider } from "@/contexts/ConversationContext";
import { ServerStatusGuard } from "@/components/ServerStatusGuard";
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

// Path-bypass entry points that load a game iframe instead of the AAC client.
const GAME_PATH_BYPASS: Record<string, string> = {
  'sandbox-app': 'sandbox-game',
  'space-trader-app': 'space-trader',
  'bubbles-app': 'bubbles-game',
};

function matchGameRoute(pathname: string): string | null {
  const trimmed = pathname.replace(/\/$/, '');
  for (const [suffix, gameId] of Object.entries(GAME_PATH_BYPASS)) {
    if (trimmed.endsWith(`/${suffix}`)) return gameId;
  }
  return null;
}

function MainApp() {
  const [selectedStudentId, setSelectedStudentId] = useState<string | null>(
    () => localStorage.getItem('synapse_student_id')
  );
  const { t, isRTL, direction, language } = useLanguage();

  // Direct routes that embed a /games/<id>/ iframe. These bypass auth/student
  // selection at the AAC-client layer; the games gate handles its own auth.
  const gameRoute = matchGameRoute(window.location.pathname);
  if (gameRoute) {
    return (
      <div className="h-screen w-screen">
        <GameEmbed
          gameId={gameRoute}
          src={`/games/${gameRoute}/`}
          forwardGaze={gameRoute === 'bubbles-game'}
          onClose={() => { window.location.href = '/aac'; }}
        />
      </div>
    );
  }

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
    // Mark as signed out locally — do NOT call server /auth/logout
    // so the admin client's session stays alive
    localStorage.setItem('aac_signed_out', 'true');
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

  // Step 1: Not authenticated or signed out locally - show login
  // The aac_signed_out flag allows AAC logout without destroying the shared server session
  const aacSignedOut = localStorage.getItem('aac_signed_out') === 'true';
  if (error || !authData?.user || aacSignedOut) {
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
          <ServerStatusGuard>
            <TooltipProvider>
              <Toaster />
              <MainApp />
              <CookieConsent />
            </TooltipProvider>
          </ServerStatusGuard>
        </LanguageProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
