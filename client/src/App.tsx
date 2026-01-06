// src/App.tsx
import React, { useEffect } from "react";
import { Switch, Route, useLocation, Redirect } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { StudentProvider, useStudent } from "@/hooks/useStudent";
import NotFound from "@/pages/not-found";
import PurchaseCredits from "@/pages/purchase-credits";
import TermsOfService from "@/pages/terms-of-service";
import OnboardingFlow from "@/pages/OnboardingFlow";
import LoginPage from "@/pages/LoginPage";
import Dashboard from "./pages/Dashboard";
import { ProtectedRoute } from "@/components/ProtectedRoute";
import "./i18n";
import { ChatProvider } from "./hooks/useChat";
import { FeaturePanelProvider } from "@/contexts/FeaturePanelContext";
import InviteSignupPage from "./pages/InviteSignupPage";
import { InstituteProvider } from "./hooks/useInstitute";

// Component to redirect authenticated users away from login page
function PublicOnlyRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading } = useAuth();
  
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"></div>
      </div>
    );
  }
  
  // If already authenticated, redirect to home
  if (isAuthenticated) {
    return <Redirect to="/" />;
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
      setLocation("/");
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

function Router() {
  return (
    <Switch>
      {/* Public routes - accessible without authentication */}
      <Route path="/login">
        <PublicOnlyRoute>
          <LoginPage />
        </PublicOnlyRoute>
      </Route>
      <Route path="/invite/:token">
        <PublicOnlyRoute>
          <InviteSignupPage />
        </PublicOnlyRoute>
      </Route>
      <Route path="/terms-of-service" component={TermsOfService} />

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
      
      {/* Student management features */}
      <Route path="/overview" component={ProtectedDashboard} />
      <Route path="/students" component={ProtectedDashboard} />
      <Route path="/progress" component={ProtectedDashboard} />
      <Route path="/institute" component={ProtectedDashboard} />
      <Route path="/reports" component={ProtectedDashboard} />
      
      {/* Settings */}
      <Route path="/settings" component={ProtectedDashboard} />

      {/* Default home route (chat) - protected */}
      <Route path="/" component={ProtectedDashboard} />

      {/* 404 fallback */}
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <AuthProvider>
          <InstituteProvider>
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
      </LanguageProvider>
    </QueryClientProvider>
  );
}

export default App;