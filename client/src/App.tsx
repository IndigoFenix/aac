import React, { useEffect } from "react";
import { Switch, Route, useLocation } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider, useQuery } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { LanguageProvider } from "@/contexts/LanguageContext";
import { ThemeProvider } from "./contexts/ThemeContext";
import { AuthProvider, useAuth } from "@/hooks/useAuth";
import { StudentProvider, useStudent } from "@/hooks/useStudent";
import NotFound from "@/pages/not-found";
import PurchaseCredits from "@/pages/purchase-credits";
import TermsOfService from "@/pages/terms-of-service";
import OnboardingFlow from "@/pages/OnboardingFlow";
import Dashboard from "./pages/Dashboard";
import "./i18n";
import { ChatProvider } from "./hooks/useChat";
import { FeaturePanelProvider } from "./contexts/FeaturePanelContext";

function OnboardingGuard({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const { students, isLoading: isStudentLoading } = useStudent();
  const [location, setLocation] = useLocation();

  const { data: onboardingStatus } = useQuery({
    queryKey: ["/api/onboarding/status"],
    enabled: !!user,
  });

  useEffect(() => {
    // Don’t decide anything until we know:
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

function Router() {
  return (
    <OnboardingGuard>
      <Switch>
        {/* Non-shell pages */}
        <Route path="/onboarding" component={OnboardingFlow} />
        <Route path="/purchase-credits" component={PurchaseCredits} />
        <Route path="/terms-of-service" component={TermsOfService} />

        {/*
          Shell (Dashboard) for all in-app feature routes.
          IMPORTANT: these paths must match what is used inside MainCanvas
        */}

        {/* SyntAACx feature */}
        <Route path="/boards" component={Dashboard} />

        {/* CommuniAACte feature root (list / main view) */}
        <Route path="/interpret" component={Dashboard} />

        {/* Example: single conversation/session detail */}
        <Route path="/interpret/sessions/:sessionId" component={Dashboard} />

        {/* DocuSLP feature */}
        <Route path="/docuslp" component={Dashboard} />

        {/* Default home/welcome inside the shell */}
        <Route path="/" component={Dashboard} />

        {/* 404 fallback for anything else */}
        <Route component={NotFound} />
      </Switch>
    </OnboardingGuard>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <LanguageProvider>
        <AuthProvider>
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
        </AuthProvider>
      </LanguageProvider>
    </QueryClientProvider>
  );
}

export default App;
