import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { useTheme } from "./ThemeProvider";
import {
  MessageSquarePlus,
  FolderOpen,
  LayoutGrid,
  Settings,
  LogOut,
  User,
  Moon,
  Sun,
} from "lucide-react";
import logoImage from "@assets/cliniaccian copy_1763565136724.png";

type LeftSidebarProps = {
  isCollapsed?: boolean;
};

export function LeftSidebar({ isCollapsed = false }: LeftSidebarProps) {
  const { theme, setTheme } = useTheme();

  const workspaceItems = [
    { icon: MessageSquarePlus, label: "New Session", testId: "button-new-session" },
    { icon: FolderOpen, label: "Saved Reports", testId: "button-saved-reports" },
    { icon: LayoutGrid, label: "My Board Library", testId: "button-board-library" },
  ];

  return (
    <div 
      className={`fixed left-0 top-0 h-screen bg-sidebar border-r border-sidebar-border flex flex-col transition-all duration-300 ${
        isCollapsed ? "w-20" : "w-80"
      }`}
    >
      <div className="p-6">
        {!isCollapsed ? (
          <div className="flex items-start gap-3">
            <img 
              src={logoImage} 
              alt="CliniAACian Logo" 
              className="w-8 h-8 flex-shrink-0"
              data-testid="img-logo"
            />
            <div className="flex-1">
              <h1 className="text-2xl font-semibold text-sidebar-foreground leading-8" data-testid="text-logo">
                CliniAACian
              </h1>
              <p className="text-xs text-muted-foreground mt-1">Vertical OS</p>
            </div>
          </div>
        ) : (
          <div className="flex justify-center" data-testid="logo-collapsed">
            <img 
              src={logoImage} 
              alt="CliniAACian Logo" 
              className="w-8 h-8"
              data-testid="img-logo-collapsed"
            />
          </div>
        )}
      </div>

      {!isCollapsed && (
        <>
          <div className="px-6 pb-6">
            <div className="bg-card border border-card-border rounded-md p-4" data-testid="card-client-context">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="w-5 h-5 text-primary" />
                </div>
                <div>
                  <p className="text-sm font-medium text-card-foreground">Sarah J.</p>
                  <p className="text-xs text-muted-foreground">Active Client</p>
                </div>
              </div>
            </div>
          </div>

          <Separator className="mx-6" />
        </>
      )}

      <div className={`py-6 space-y-2 flex-1 ${isCollapsed ? "px-2" : "px-6"}`}>
        {!isCollapsed && (
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4">
            Workspace
          </p>
        )}
        {workspaceItems.map((item) => (
          <Button
            key={item.label}
            variant="ghost"
            className={`w-full gap-3 hover-elevate active-elevate-2 ${
              isCollapsed ? "justify-center px-0" : "justify-start"
            }`}
            data-testid={item.testId}
            onClick={() => console.log(`${item.label} clicked`)}
            title={isCollapsed ? item.label : undefined}
          >
            <item.icon className="w-5 h-5" />
            {!isCollapsed && <span className="text-sm">{item.label}</span>}
          </Button>
        ))}
      </div>

      {!isCollapsed && <Separator className="mx-6" />}

      <div className={`py-6 space-y-4 ${isCollapsed ? "px-2" : "px-6"}`}>
        {!isCollapsed ? (
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {theme === "dark" ? (
                <Moon className="w-4 h-4 text-sidebar-foreground" />
              ) : (
                <Sun className="w-4 h-4 text-sidebar-foreground" />
              )}
              <span className="text-sm text-sidebar-foreground">Dark Mode</span>
            </div>
            <Switch
              checked={theme === "dark"}
              onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
              data-testid="switch-theme"
            />
          </div>
        ) : (
          <Button
            size="icon"
            variant="ghost"
            className="w-full hover-elevate active-elevate-2"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            data-testid="button-theme-collapsed"
            title="Toggle theme"
          >
            {theme === "dark" ? (
              <Moon className="w-5 h-5 text-sidebar-foreground" />
            ) : (
              <Sun className="w-5 h-5 text-sidebar-foreground" />
            )}
          </Button>
        )}

        <Button
          variant="ghost"
          className={`w-full gap-3 hover-elevate active-elevate-2 ${
            isCollapsed ? "justify-center px-0" : "justify-start"
          }`}
          data-testid="button-settings"
          onClick={() => console.log("Settings clicked")}
          title={isCollapsed ? "Settings" : undefined}
        >
          <Settings className="w-5 h-5" />
          {!isCollapsed && <span className="text-sm">Settings</span>}
        </Button>

        <Button
          variant="ghost"
          className={`w-full gap-3 hover-elevate active-elevate-2 ${
            isCollapsed ? "justify-center px-0" : "justify-start"
          }`}
          data-testid="button-logout"
          onClick={() => console.log("Log Out clicked")}
          title={isCollapsed ? "Log Out" : undefined}
        >
          <LogOut className="w-5 h-5" />
          {!isCollapsed && <span className="text-sm">Log Out</span>}
        </Button>
      </div>
    </div>
  );
}
