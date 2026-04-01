// src/App.tsx
import React, { useEffect } from "react";
import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { SoundProvider } from "@/contexts/SoundContext";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { StudentProvider, useStudent } from "@/hooks/useStudent";
import { StudentLabelSync } from "@/hooks/useStudentLabel";
import NotFound from "@/pages/not-found";
import PurchaseCredits from "@/pages/purchase-credits";
import TermsOfService from "@/pages/terms-of-service";
import PrivacyPolicy from "@/pages/privacy-policy";
import CookiePolicy from "@/pages/cookie-policy";
import AccessibilityStatement from "@/pages/accessibility-statement";
import AIPolicy from "@/pages/ai-policy";
import OnboardingFlow from "@/pages/OnboardingFlow";
import LoginPage from "@/pages/LoginPage";
import Dashboard from "./pages/Dashboard";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import { ServerStatusGuard } from "@/components/ServerStatusGuard";
import "./i18n";
import { ChatProvider } from "./hooks/useChat";
import { FeaturePanelProvider } from "@/contexts/FeaturePanelContext";
import { InstituteProvider } from "./hooks/useInstitute";
import ForgotPasswordPage from "./pages/forgotPasswordPage";
import MfaRecoveryPage from "./pages/MfaRecoveryPage";
import { AdminDashboard } from "./pages/AdminDashboard";
import LandingPage from "./components/landing-page/LandingPage";

// Component to redirect authenticated users away from login page
function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  // If already authenticated, redirect to the appropriate page
  if (isAuthenticated) {
    const dest = (user?.isSystemAdmin && !user?.supportSession) ? '/admin' : '/home';
    return <Redirect to={dest} />;
  }

  return <>{children}</>;
}

// For invite routes - don't redirect authenticated users since they may need to accept the invite
function InviteRoute({ children }: { children: React.ReactNode }) {
  const { isLoading } = useAuth();
  
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }
  
  return <>{children}</>;
}

function OnboardingGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { students, isLoading: isStudentLoading } = useStudent();
  const [location, setLocation] = useLocation();

  const { data: onboardingStatus } = useQuery({
    queryKey: ["/api/onboarding/status"],
    enabled: !!user,
  });

  useEffect(() => {
    // Don't decide anything until we know:
    // - user is loaded
    // - onboarding status is loaded
    // - students have finished loading
    if (!user || !onboardingStatus || isStudentLoading) {
      return;
    }

    const onboardingStep = (onboardingStatus as any)?.onboardingStep ?? 0;
    const hasStudents = Array.isArray(students) && students.length > 0;

    return;
    // Ignore onboarding process for now, not important

    // Only redirect to onboarding if user hasn't completed it AND has no students
    if (onboardingStep < 3 && !hasStudents && location !== "/onboarding") {
      setLocation("/onboarding");
    }

    // If user has completed onboarding or has students, and is on onboarding page, redirect to home
    if ((onboardingStep === 3 || hasStudents) && location === "/onboarding") {
      setLocation("/home");
    }
  }, [user, onboardingStatus, isStudentLoading, students, location, setLocation]);

  return <>{children}</>;
}

// Wrapper for protected dashboard routes
function ProtectedDashboard() {
  return (
    <ProtectedRoute>
      <OnboardingGuard>
        <Dashboard />
      </OnboardingGuard>
    </ProtectedRoute>
  );
}

// Protected route that requires system admin privileges
function SystemAdminRoute({ children }: { children: React.ReactNode }) {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Redirect to="/login" />;
  }

  if (!user?.isSystemAdmin) {
    return <Redirect to="/home" />;
  }

  return <>{children}</>;
}

function Router() {
  return (
    <Switch>
      {/* Public routes - accessible without authentication */}
      <Route path="/login">
        <PublicOnlyRoute>
          <LoginPage />
        </PublicOnlyRoute>
      </Route>
      <Route path="/forgot-password">
        <PublicOnlyRoute>
          <ForgotPasswordPage />
        </PublicOnlyRoute>
      </Route>
      {/* Invite route - uses the same LoginPage but with invite token handling */}
      <Route path="/invite/:token">
        <InviteRoute>
          <LoginPage />
        </InviteRoute>
      </Route>
      <Route path="/terms-of-service" component={TermsOfService} />
      <Route path="/privacy-policy" component={PrivacyPolicy} />
      <Route path="/cookie-policy" component={CookiePolicy} />
      <Route path="/accessibility" component={AccessibilityStatement} />
      <Route path="/ai-policy" component={AIPolicy} />

      {/* MFA Recovery routes */}
      <Route path="/mfa-recovery">
        <PublicOnlyRoute>
          <MfaRecoveryPage />
        </PublicOnlyRoute>
      </Route>
      <Route path="/mfa-recovery/:token">
        <MfaRecoveryPage />
      </Route>

      {/* Protected routes - require authentication */}
      <Route path="/onboarding">
        <ProtectedRoute>
          <OnboardingFlow />
        </ProtectedRoute>
      </Route>
      
      <Route path="/purchase-credits">
        <ProtectedRoute>
          <PurchaseCredits />
        </ProtectedRoute>
      </Route>

      {/* Dashboard feature routes - all protected */}
      {/* Core workspace features */}
      <Route path="/boards" component={ProtectedDashboard} />
      <Route path="/interpret" component={ProtectedDashboard} />
      <Route path="/interpret/sessions/:sessionId" component={ProtectedDashboard} />
      <Route path="/docuslp" component={ProtectedDashboard} />
      <Route path="/symbols" component={ProtectedDashboard} />
      
      {/* Student management features */}
      <Route path="/overview" component={ProtectedDashboard} />
      <Route path="/students" component={ProtectedDashboard} />
      <Route path="/aacsettings" component={ProtectedDashboard} />
      <Route path="/progress" component={ProtectedDashboard} />
      <Route path="/institute" component={ProtectedDashboard} />
      <Route path="/reports" component={ProtectedDashboard} />
      <Route path="/calendar" component={ProtectedDashboard} />
      
      {/* Settings */}
      <Route path="/settings" component={ProtectedDashboard} />

      {/* Admin routes - require system admin */}
      <Route path="/admin/personas">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/library/:topicId">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/library">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/voices">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/models">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/sessions">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/contacts">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/licenses">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/activity-log">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>

      {/* Authenticated home (chat/dashboard) */}
      <Route path="/home" component={ProtectedDashboard} />

      {/* Landing page for unauthenticated users, redirects to /home if logged in */}
      <Route path="/" component={LandingPage} />

      {/* 404 fallback */}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <ServerStatusGuard>
          <SoundProvider>
            <AuthProvider>
              <InstituteProvider>
                <StudentLabelSync />
                <StudentProvider>
                  <FeaturePanelProvider>
                    <ChatProvider>
                      <ThemeProvider defaultTheme="dark">
                        <TooltipProvider>
                          <Toaster />
                          <Router />
                        </TooltipProvider>
                      </ThemeProvider>
                    </ChatProvider>
                  </FeaturePanelProvider>
                </StudentProvider>
              </InstituteProvider>
            </AuthProvider>
          </SoundProvider>
        </ServerStatusGuard>
      </LanguageProvider>
    </QueryClientProvider>
  );
}

export default App;