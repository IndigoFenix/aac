// src/App.tsx
import React, { useEffect } from "react";
import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AccessibilityProvider } from "@/contexts/AccessibilityContext";
import { CookieConsent } from "@/components/CookieConsent";
import { SoundProvider } from "@/contexts/SoundContext";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { StudentProvider, useStudent } from "@/hooks/useStudent";
import { StudentLabelSync } from "@/hooks/useStudentLabel";
import NotFound from "@/pages/not-found";
import PurchaseCredits from "@/pages/purchase-credits";
import PaddleTest from "@/pages/paddle-test";
import SttTestPanel from "@/features/sttTest/SttTestPanel";
import TermsOfService from "@/pages/terms-of-service";
import PrivacyPolicy from "@/pages/privacy-policy";
import CookiePolicy from "@/pages/cookie-policy";
import ConsentSignPage from "@/pages/ConsentSignPage";
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
import { PersonChatProvider } from "./features/personChat/PersonChatContext";
import { CallProvider } from "./features/call/CallContext";
import { CallView } from "./features/call/CallView";
import { IncomingCallModal } from "./features/call/IncomingCallModal";
import { IdentityVerificationDialog } from "./components/IdentityVerificationDialog";
import ForgotPasswordPage from "./pages/forgotPasswordPage";
import MfaRecoveryPage from "./pages/MfaRecoveryPage";
import { AdminDashboard } from "./pages/AdminDashboard";
import AdminLoginPage from "./pages/AdminLoginPage";
import AdminForgotPasswordPage from "./pages/AdminForgotPasswordPage";
import AdminResetPasswordPage from "./pages/AdminResetPasswordPage";
import AdminMfaRecoveryPage from "./pages/AdminMfaRecoveryPage";
import LandingPage from "./components/landing-page/LandingPage";
import { SUPPORTED_LANGUAGES } from "@/i18n";

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

// Protected route that requires system admin privileges. Used for the
// nested /admin/<section> routes — landing on one of these while unauthed
// kicks you to the admin login (/admin), not the regular /login.
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
    return <Redirect to="/admin" />;
  }

  if (!user?.isSystemAdmin) {
    return <Redirect to="/home" />;
  }

  return <>{children}</>;
}

// Entry point for /admin (the bare path). Unauthenticated visitors get the
// admin login form here; authenticated system admins go straight to the
// dashboard; authenticated non-admins are bounced to /home so the route
// isn't usable as a side-channel landing.
function AdminEntryRoute() {
  const { user, isAuthenticated, isLoading } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <AdminLoginPage />;
  }

  if (!user?.isSystemAdmin) {
    return <Redirect to="/home" />;
  }

  return <AdminDashboard />;
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

      {/* Magic-link consent — public, token-authed (parents may not have accounts). */}
      <Route path="/consent/sign" component={ConsentSignPage} />

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

      <Route path="/paddle-test">
        <ProtectedRoute>
          <PaddleTest />
        </ProtectedRoute>
      </Route>

      <Route path="/stt-test">
        <ProtectedRoute>
          <SttTestPanel />
        </ProtectedRoute>
      </Route>

      {/* Dashboard feature routes - all protected */}
      {/* Core workspace features */}
      <Route path="/boards" component={ProtectedDashboard} />
      <Route path="/custom-apps" component={ProtectedDashboard} />
      <Route path="/interpret" component={ProtectedDashboard} />
      <Route path="/interpret/sessions/:sessionId" component={ProtectedDashboard} />
      <Route path="/docuslp" component={ProtectedDashboard} />
      <Route path="/symbols" component={ProtectedDashboard} />
      
      {/* Student management features */}
      <Route path="/overview" component={ProtectedDashboard} />
      <Route path="/students" component={ProtectedDashboard} />
      <Route path="/student-info" component={ProtectedDashboard} />
      <Route path="/aacsettings" component={ProtectedDashboard} />
      <Route path="/progress" component={ProtectedDashboard} />
      <Route path="/contacts" component={ProtectedDashboard} />
      <Route path="/institute" component={ProtectedDashboard} />
      <Route path="/reports" component={ProtectedDashboard} />
      <Route path="/calendar" component={ProtectedDashboard} />
      <Route path="/locations" component={ProtectedDashboard} />
      <Route path="/userchat" component={ProtectedDashboard} />
      <Route path="/call" component={ProtectedDashboard} />
      <Route path="/deep-analysis" component={ProtectedDashboard} />
      <Route path="/shares" component={ProtectedDashboard} />
      <Route path="/insurance-bridge" component={ProtectedDashboard} />
      <Route path="/video-caption" component={ProtectedDashboard} />
      <Route path="/downloads" component={ProtectedDashboard} />

      {/* Settings */}
      <Route path="/settings" component={ProtectedDashboard} />

      {/* Admin public auth-flow routes — must precede the bare /admin entry
          so they take precedence inside wouter's Switch. */}
      <Route path="/admin/forgot-password">
        <AdminForgotPasswordPage />
      </Route>
      <Route path="/admin/reset-password/:token">
        <AdminResetPasswordPage />
      </Route>
      <Route path="/admin/mfa-recovery">
        <AdminMfaRecoveryPage />
      </Route>
      <Route path="/admin/mfa-recovery/:token">
        <AdminMfaRecoveryPage />
      </Route>

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
      <Route path="/admin/cost-usage">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/contacts">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/licenses/:licenseId/students/:studentId">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/licenses/:licenseId/students">
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
      <Route path="/admin/deep-analyses">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/public-symbols">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/identity-providers">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/crm/customers/:customerId">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/crm">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      <Route path="/admin/admins">
        <SystemAdminRoute>
          <AdminDashboard />
        </SystemAdminRoute>
      </Route>
      {/* Bare /admin: unauthenticated visitors get the admin login form,
          authenticated system admins get the dashboard. */}
      <Route path="/admin">
        <AdminEntryRoute />
      </Route>

      {/* Authenticated home (chat/dashboard) */}
      <Route path="/home" component={ProtectedDashboard} />

      {/* Landing page for unauthenticated users, redirects to /home if logged in.
          Per-locale paths (/he, /es, ...) serve the same landing component — the
          locale is read from the URL by LanguageProvider. These match the prerendered
          SEO pages on the server. */}
      {SUPPORTED_LANGUAGES.filter(l => l.code !== "en").map(lang => (
        <Route key={lang.code} path={`/${lang.code}`} component={LandingPage} />
      ))}
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
                <IdentityVerificationDialog />
                <StudentLabelSync />
                <StudentProvider>
                  <PersonChatProvider>
                  <CallProvider>
                  <FeaturePanelProvider>
                    <ChatProvider>
                      <ThemeProvider defaultTheme="light">
                        <AccessibilityProvider>
                          <TooltipProvider>
                            <Toaster />
                            <Router />
                            <CallView />
                            <IncomingCallModal />
                            <CookieConsent />
                          </TooltipProvider>
                        </AccessibilityProvider>
                      </ThemeProvider>
                    </ChatProvider>
                  </FeaturePanelProvider>
                  </CallProvider>
                  </PersonChatProvider>
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