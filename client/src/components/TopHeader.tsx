// src/components/TopHeader.tsx
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { User, Menu, Settings, LogOut, LogIn, Shield } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { useAacUser } from "@/hooks/useAacUser";
import { useLanguage } from "@/contexts/LanguageContext";
import { LanguageSelector } from "@/components/LanguageSelector";
import { openUI } from "@/lib/uiEvents";
import { useLocation } from "react-router-dom";

type TopHeaderProps = {
  onToggleSidebar?: () => void;
};
type FeatureId = "boards" | "interpret" | "docuslp" | null;

export function TopHeader({ onToggleSidebar }: TopHeaderProps) {
  const { user, isAuthenticated, isLoading, logout } = useAuth();
  const { aacUser, aacUsers, isLoading: isAacUserLoading, selectAacUser } = useAacUser();
  const { t } = useLanguage();
  const location = useLocation();

  const getActiveFeatureFromPath = (): FeatureId => {
    const segments = location.pathname.split("/").filter(Boolean);
    // segments[0] = "dashboard"; segments[1] = feature slug (if present)
    const featureSlug = segments[0];

    switch (featureSlug) {
      case "boards":
        return "boards";
      case "interpret":
        return "interpret";
      case "docuslp":
        return "docuslp";
      default:
        return null;
    }
  };

  const getHeaderTitle = (): string => {
    const feature = getActiveFeatureFromPath();
    switch (feature) {
      case "boards":
        return "SyntAACx Boards";
      case "interpret":
        return "CommuniAACte";
      case "docuslp":
        return "DocuSLP Reports";
      default:
        return "AAC Workspace";
    }
  };

  return (
    <div className="h-16 border-b border-border bg-background px-4 sm:px-6 flex items-center justify-between">
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleSidebar}
          data-testid="button-toggle-sidebar"
          className="hover-elevate active-elevate-2"
        >
          <Menu className="w-5 h-5" />
        </Button>
        <span className="text-sm sm:text-base font-medium">{getHeaderTitle()}</span>
      </div>

      <div className="flex items-center gap-2 sm:gap-3">
        {isAuthenticated && user && (
          <div className="flex items-center gap-2">
            <label
              htmlFor="aac-user-selector"
              className="hidden sm:inline text-xs text-muted-foreground"
            >
              Student
            </label>
            <select
              id="aac-user-selector"
              className="max-w-[180px] text-xs sm:text-sm border border-input bg-background rounded-md px-2 py-1 focus:outline-none focus:ring-2 focus:ring-primary"
              value={aacUser?.id ?? ""}
              disabled={isAacUserLoading || !aacUsers.length}
              onChange={(event) => {
                const selectedId = event.target.value;
                void selectAacUser(selectedId || undefined);
              }}
            >
              <option value="">
                {isAacUserLoading
                  ? "Loading students..."
                  : aacUsers.length
                  ? "Select student"
                  : "No AAC users"}
              </option>
              {aacUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
        )}

        {isAuthenticated && user ? (
          <>
            {/* Credits */}
            <div className="hidden sm:flex items-center text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{user.credits}</span>
              <span className="ml-1">credits</span>
            </div>

            {/* Admin portal */}
            {(user.userType === "admin" || user.isAdmin) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => (window.location.href = "/admin")}
                className="text-xs px-2 py-1 bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100"
                data-testid="button-admin"
                aria-label="Access admin panel"
              >
                <Shield className="w-4 h-4" />
              </Button>
            )}

            {/* Profile, Settings, Logout */}
            <div className="flex items-center gap-2">
              <div className="text-right hidden sm:block">
                <p className="text-sm font-medium text-foreground">
                  {user.firstName || "User"}
                </p>
                <p className="text-xs text-muted-foreground">Active</p>
              </div>
              <Avatar className="w-8 h-8">
                <AvatarFallback className="bg-primary/10">
                  <User className="w-4 h-4 text-primary" />
                </AvatarFallback>
              </Avatar>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openUI("settings")}
                aria-label="User settings"
              >
                <Settings className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={logout}
                aria-label={t("auth.logout")}
              >
                <LogOut className="w-4 h-4" />
              </Button>
            </div>
          </>
        ) : (
          !isLoading && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => openUI("login")}
              className="p-1.5"
              title={t("auth.login")}
              data-testid="button-login"
            >
              <LogIn className="w-4 h-4" />
            </Button>
          )
        )}

        {/* Language */}
        <LanguageSelector />
      </div>
    </div>
  );
}
