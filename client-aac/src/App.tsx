import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Home from "@/pages/home";
import GameEmbed from "@/components/games/GameEmbed";
import SocialWorldCanvas from "@/components/social-world/SocialWorldCanvas";
import SymbolGameSandbox from "@/components/games/SymbolGameSandbox";
import { CameraProvider } from "@/components/CameraProvider";
import { MultiCameraProvider } from "@/hooks/useMultiCamera";
import LoginModal from "@/components/LoginModal";
import StudentSelector from "@/components/StudentSelector";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { LanguageProvider, useLanguage } from "@/contexts/LanguageContext";
import { CookieConsent } from "@/components/CookieConsent";
import { AppInitializationProvider } from "@/contexts/AppInitializationContext";
import { BoardsProvider } from "@/contexts/BoardsContext";
import { ConversationProvider } from "@/contexts/ConversationContext";
import { ServerStatusGuard } from "@/components/ServerStatusGuard";
import { DeviceLimitOverlay } from "@/components/DeviceManager";
import AppVersionBadge from "@/components/AppVersionBadge";
import UpdateStatusIndicator from "@/components/UpdateStatusIndicator";
import DebugConsole from "@/components/DebugConsole";
import { useDeviceRegistration } from "@/hooks/useDeviceRegistration";
import { deregisterCurrentDevice } from "@/lib/device-id";
import { preloadClientModels } from "@/lib/preloadModels";
import { useEffect, useState } from "react";

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
  'musical-microbes-app': 'musical-microbes',
  'quest-app': 'goal-tree-player',
  'dollhouse-app': 'dollhouse',
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
  const [selectedClassroomId, setSelectedClassroomId] = useState<string | null>(
    () => localStorage.getItem('synapse_classroom_id')
  );
  const { t, isRTL, direction, language } = useLanguage();

  // Warm the on-device models (Silero VAD, FaceLandmarker) while auth/session
  // startup runs, so they're ready before the first mic/camera attach. Game
  // bypass routes don't use them — skip the download there.
  useEffect(() => {
    const trimmed = window.location.pathname.replace(/\/$/, "");
    if (matchGameRoute(window.location.pathname)) return;
    if (trimmed.endsWith("/social-world") || trimmed.endsWith("/symbol-game")) return;
    preloadClientModels();
  }, []);

  // Dev/test bypass: the single-player social-world canvas, reachable at
  // /social-world with no auth/student selection. Lets the world's render +
  // steering + ball feel be tuned before the room/join system exists.
  if (window.location.pathname.replace(/\/$/, "").endsWith("/social-world")) {
    return (
      <div className="h-screen w-screen">
        <SocialWorldCanvas />
      </div>
    );
  }

  // Dev/test bypass: the symbol-learning game with its AAC button-board
  // interface but NO live AI session, reachable at /symbol-game with no
  // auth/student selection. The game judges itself client-side; the AI is only
  // ever a narration companion, so it's fully playable standalone.
  if (window.location.pathname.replace(/\/$/, "").endsWith("/symbol-game")) {
    return <SymbolGameSandbox />;
  }

  // Direct routes that embed a /games/<id>/ iframe. These bypass auth/student
  // selection at the AAC-client layer; the games gate handles its own auth.
  const gameRoute = matchGameRoute(window.location.pathname);
  if (gameRoute) {
    return (
      <div className="h-screen w-screen">
        <GameEmbed
          gameId={gameRoute}
          src={`/games/${gameRoute}/`}
          forwardGaze={gameRoute === 'bubbles-game' || gameRoute === 'musical-microbes' || gameRoute === 'sandbox-game' || gameRoute === 'goal-tree-player' || gameRoute === 'dollhouse'}
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

  // The aac_signed_out flag allows AAC logout without destroying the shared server session
  const aacSignedOut = localStorage.getItem('aac_signed_out') === 'true';
  const authedUser = !error && !aacSignedOut ? authData?.user ?? null : null;

  // synapse_student_id is a bare localStorage value with no notion of WHICH
  // user picked it. On a shared device, a prior account's selection can
  // outlive that account's session (e.g. the server session simply expired
  // instead of going through handleLogout/handleExitStudent, which clear it)
  // and get inherited by the next login. synapse_student_owner_id records who
  // made the selection, so a login under a different account clears the
  // stale student instead of trying — and failing — to load their boards.
  useEffect(() => {
    if (!authedUser || !selectedStudentId) return;
    const storedOwnerId = localStorage.getItem('synapse_student_owner_id');
    if (storedOwnerId && storedOwnerId !== authedUser.id) {
      localStorage.removeItem('synapse_student_id');
      localStorage.removeItem('synapse_classroom_id');
      localStorage.removeItem('synapse_student_owner_id');
      setSelectedStudentId(null);
      setSelectedClassroomId(null);
    }
  }, [authedUser?.id]);

  // Register this device to the selected student (and re-check the license
  // device limit) on every selection AND on startup with a restored student.
  const deviceReg = useDeviceRegistration(authedUser ? selectedStudentId : null);

  // "You tried to connect to a student with the wrong permissions" must never
  // strand the app: the server definitively said this account cannot act for
  // the cached student (typically a stale synapse_student_id left by a
  // different account on a shared device), so drop the selection and fall
  // back to the student selector. No deregister call here — it would hit the
  // same 403.
  useEffect(() => {
    if (deviceReg.status !== "denied") return;
    localStorage.removeItem('synapse_student_id');
    localStorage.removeItem('synapse_classroom_id');
    localStorage.removeItem('synapse_student_owner_id');
    setSelectedStudentId(null);
    setSelectedClassroomId(null);
  }, [deviceReg.status]);

  // React Query keys every user-scoped list by RESOURCE, never by account
  // (["/api/institutes"], ["/api/students", …], the classroom lists), and this
  // client's default staleTime is Infinity. So without an explicit purge the
  // institute/classroom/student lists a previous account loaded stayed in the
  // cache across a sign-out and were served — and never refetched — to whoever
  // signed in next on the same device.
  //
  // The purge that does the real work is the one on LOGIN: at that moment the
  // login screen is the only thing mounted, so nothing re-fetches the lists
  // before the new account's identity is known. The logout-side purge is a
  // backstop only — AAC sign-out is local (the server session deliberately
  // stays alive for the clinician client), so a still-mounted selector can
  // briefly re-fetch the outgoing account's lists on its way out.
  //
  // The auth query itself is left alone: it is the source of `authedUser`, and
  // removing it would bounce the app back through its loading screen.
  const clearUserScopedCache = () => {
    queryClient.removeQueries({ predicate: (q) => q.queryKey[0] !== "/auth/user" });
  };

  const handleLoginSuccess = () => {
    clearUserScopedCache();
    refetch();
  };

  const handleLogout = () => {
    // Best-effort: free this device's slot before dropping the student locally.
    // If it fails (offline), the server-side recheck on next login reconciles.
    if (selectedStudentId) void deregisterCurrentDevice(selectedStudentId);
    setSelectedStudentId(null);
    setSelectedClassroomId(null);
    localStorage.removeItem('synapse_student_id');
    localStorage.removeItem('synapse_classroom_id');
    localStorage.removeItem('synapse_student_owner_id');
    localStorage.removeItem('synapse_user_profile');
    // Mark as signed out locally — do NOT call server /auth/logout
    // so the admin client's session stays alive
    localStorage.setItem('aac_signed_out', 'true');
    clearUserScopedCache();
    queryClient.setQueryData(["/auth/user"], null);
  };

  const handleStudentSelect = (studentId: string, classroomId?: string | null) => {
    localStorage.setItem('synapse_student_id', studentId);
    if (authedUser) localStorage.setItem('synapse_student_owner_id', authedUser.id);
    setSelectedStudentId(studentId);
    if (classroomId) {
      localStorage.setItem('synapse_classroom_id', classroomId);
      setSelectedClassroomId(classroomId);
    } else {
      localStorage.removeItem('synapse_classroom_id');
      setSelectedClassroomId(null);
    }
  };

  const handleExitStudent = () => {
    if (selectedStudentId) void deregisterCurrentDevice(selectedStudentId);
    localStorage.removeItem('synapse_student_id');
    localStorage.removeItem('synapse_classroom_id');
    localStorage.removeItem('synapse_student_owner_id');
    setSelectedStudentId(null);
    setSelectedClassroomId(null);
  };

  // Show loading while checking authentication
  if (isLoading) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center" dir={direction}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-300">{t("app.loading")}</p>
        </div>
        <UpdateStatusIndicator />
        <AppVersionBadge />
      </div>
    );
  }

  // Step 1: Not authenticated or signed out locally - show login
  if (!authedUser) {
    return (
      <>
        <LoginModal
          isOpen={true}
          onClose={handleLoginSuccess}
        />
        <UpdateStatusIndicator />
        <AppVersionBadge />
      </>
    );
  }

  // Step 2: Authenticated but no student selected - show student selector
  if (!selectedStudentId) {
    return (
      <>
        <StudentSelector
          user={authedUser}
          onStudentSelect={handleStudentSelect}
          onLogout={handleLogout}
        />
        <UpdateStatusIndicator />
        <AppVersionBadge />
      </>
    );
  }

  // Step 2.5: device gate — don't start the (expensive) AAC session until this
  // device is confirmed against the student's license device limit. The check
  // fails open on network errors, so offline devices are never locked out.
  // "denied" holds here too: the effect above is about to clear the student
  // and re-render into the selector — the AAC session must not start first.
  if (deviceReg.status === "checking" || deviceReg.status === "denied") {
    return (
      <div className="min-h-screen bg-gradient-to-br from-purple-50 to-indigo-100 dark:from-gray-900 dark:to-gray-800 flex items-center justify-center" dir={direction}>
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto"></div>
          <p className="mt-4 text-gray-600 dark:text-gray-300">{t("app.loading")}</p>
        </div>
        <UpdateStatusIndicator />
        <AppVersionBadge />
      </div>
    );
  }
  if (deviceReg.status === "blocked") {
    return (
      <DeviceLimitOverlay
        devices={deviceReg.devices}
        limit={deviceReg.limit}
        isRegistered={deviceReg.isRegistered}
        busy={deviceReg.busy}
        checking={false}
        onDeregister={(recordId) => void deviceReg.deregister(recordId)}
        onRetry={deviceReg.retry}
        onExitStudent={handleExitStudent}
      />
    );
  }

  // Step 3: Student selected - show AAC interface with initialization
  return (
    <AppInitializationProvider>
      <CameraProvider>
        <MultiCameraProvider>
          <BoardsProvider studentId={selectedStudentId}>
            <ConversationProvider studentId={selectedStudentId} language={language}>
              <Home
                studentId={selectedStudentId}
                classroomId={selectedClassroomId}
                onLogout={handleLogout}
                onExitStudent={handleExitStudent}
              />
            </ConversationProvider>
          </BoardsProvider>
        </MultiCameraProvider>
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
              {/* Mounted at the root so on-device logs are reachable even on the
                  login screen (4-finger tap / Ctrl+Shift+D). See DebugConsole. */}
              <DebugConsole />
            </TooltipProvider>
          </ServerStatusGuard>
        </LanguageProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
