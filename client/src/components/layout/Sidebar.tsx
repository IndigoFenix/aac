// src/components/layout/Sidebar.tsx
import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import {
  MessageSquarePlus,
  FolderOpen,
  LayoutGrid,
  BookOpen,
  Settings,
  LogOut,
  User,
  Moon,
  Sun,
} from 'lucide-react';
import logoImage from '@assets/cliniaccian copy_1763565136724.png';
import { useAuth } from '@/hooks/useAuth';
import { openUI } from '@/lib/uiEvents';
import { cn } from '@/lib/utils';

type SidebarProps = {
  isCollapsed?: boolean;
  position?: 'left' | 'right';
};

export function Sidebar({ isCollapsed = false, position = 'left' }: SidebarProps) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const { t, isRTL } = useLanguage();
  const { activeFeature, setActiveFeature } = useFeaturePanel();

  const workspaceItems = [
    {
      icon: BookOpen,
      labelKey: 'nav.main',
      feature: 'chat' as const,
      path: '/',
      testId: 'nav-main',
    },
    {
      icon: MessageSquarePlus,
      labelKey: 'nav.interpret',
      feature: 'interpret' as const,
      path: '/interpret',
      testId: 'nav-interpret',
    },
    {
      icon: FolderOpen,
      labelKey: 'nav.boards',
      feature: 'boards' as const,
      path: '/boards',
      testId: 'nav-boards',
    },
    {
      icon: LayoutGrid,
      labelKey: 'nav.docuslp',
      feature: 'docuslp' as const,
      path: '/docuslp',
      testId: 'nav-docuslp',
    },
  ];

  const positionClasses = position === 'right' 
    ? 'right-0 border-l' 
    : 'left-0 border-r';

  return (
    <div 
      className={cn(
        "fixed top-0 h-screen bg-sidebar border-sidebar-border flex flex-col transition-all duration-300",
        positionClasses,
        isCollapsed ? "w-20" : "w-80"
      )}
    >
      {/* Logo */}
      <div className="p-6">
        {!isCollapsed ? (
          <div className={cn(
            "flex items-start gap-3",
            isRTL && "flex-row-reverse"
          )}>
            <img 
              src={logoImage} 
              alt="CliniAACian Logo" 
              className="w-8 h-8 flex-shrink-0"
              data-testid="img-logo"
            />
            <div className="flex-1">
              <h1 
                className={cn(
                  "text-2xl font-semibold text-sidebar-foreground leading-8",
                  isRTL && "text-right"
                )} 
                data-testid="text-logo"
              >
                CliniAACian
              </h1>
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

      {/* User card */}
      {!isCollapsed && user && (
        <>
          <div className="px-6 pb-6">
            <div 
              className="bg-card border border-card-border rounded-md p-4" 
              data-testid="card-client-context"
            >
              <div className={cn(
                "flex items-center gap-3",
                isRTL && "flex-row-reverse"
              )}>
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="w-5 h-5 text-primary" />
                </div>
                <div className={isRTL ? "text-right" : ""}>
                  <p className="text-sm font-medium text-card-foreground">
                    {user.fullName}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('header.active')}
                  </p>
                </div>
              </div>
            </div>
          </div>

          <Separator className="mx-6" />
        </>
      )}

      {/* Navigation */}
      <div className={cn("py-6 space-y-2 flex-1", isCollapsed ? "px-2" : "px-6")}>
        {!isCollapsed && (
          <p className={cn(
            "text-xs font-medium text-muted-foreground uppercase tracking-wide mb-4",
            isRTL && "text-right"
          )}>
            {t('nav.workspace')}
          </p>
        )}
        
        <div className="space-y-2">
          {workspaceItems.map((item) => {
            const isActive = activeFeature === item.feature;
            
            return (
              <Button
                key={item.labelKey}
                variant={isActive ? "secondary" : "ghost"}
                size="sm"
                className={cn(
                  "w-full gap-2 hover-elevate active-elevate-2",
                  isRTL ? "flex-row-reverse justify-end" : "justify-start"
                )}
                data-testid={item.testId}
                onClick={() => setActiveFeature(item.feature)}
              >
                <item.icon className="w-4 h-4" />
                {!isCollapsed && <span>{t(item.labelKey)}</span>}
              </Button>
            );
          })}
        </div>
      </div>

      {!isCollapsed && <Separator className="mx-6" />}

      {/* Bottom section */}
      <div className={cn("py-6 space-y-4", isCollapsed ? "px-2" : "px-6")}>
        {/* Theme toggle */}
        {!isCollapsed ? (
          <div className={cn(
            "flex items-center justify-between",
            isRTL && "flex-row-reverse"
          )}>
            <div className={cn(
              "flex items-center gap-3",
              isRTL && "flex-row-reverse"
            )}>
              {theme === "dark" ? (
                <Moon className="w-4 h-4 text-sidebar-foreground" />
              ) : (
                <Sun className="w-4 h-4 text-sidebar-foreground" />
              )}
              <span className="text-sm text-sidebar-foreground">
                {t('settings.darkMode')}
              </span>
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
            title={t('settings.darkMode')}
          >
            {theme === "dark" ? (
              <Moon className="w-5 h-5 text-sidebar-foreground" />
            ) : (
              <Sun className="w-5 h-5 text-sidebar-foreground" />
            )}
          </Button>
        )}

        {/* Settings */}
        <Button
          variant="ghost"
          className={cn(
            "w-full gap-3 hover-elevate active-elevate-2",
            isCollapsed 
              ? "justify-center px-0" 
              : (isRTL ? "flex-row-reverse justify-end" : "justify-start")
          )}
          data-testid="button-settings"
          onClick={() => openUI("settings")}
          title={isCollapsed ? t('nav.settings') : undefined}
        >
          <Settings className="w-5 h-5" />
          {!isCollapsed && <span className="text-sm">{t('nav.settings')}</span>}
        </Button>

        {/* Logout */}
        <Button
          variant="ghost"
          className={cn(
            "w-full gap-3 hover-elevate active-elevate-2",
            isCollapsed 
              ? "justify-center px-0" 
              : (isRTL ? "flex-row-reverse justify-end" : "justify-start")
          )}
          data-testid="button-logout"
          onClick={logout}
          title={isCollapsed ? t('auth.logout') : undefined}
        >
          <LogOut className="w-5 h-5" />
          {!isCollapsed && <span className="text-sm">{t('auth.logout')}</span>}
        </Button>
      </div>
    </div>
  );
}