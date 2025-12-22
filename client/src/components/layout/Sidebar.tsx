// src/components/layout/Sidebar.tsx
// Updated with student management navigation items and proper RTL support
// Fixed theme toggle alignment to match other buttons

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import { Badge } from '@/components/ui/badge';
import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { useStudent } from '@/hooks/useStudent';
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
  Users,
  BarChart3,
  ClipboardList,
  GraduationCap,
  ChevronRight,
} from 'lucide-react';
import logoImage from '@assets/cliniaccian copy_1763565136724.png';
import { useAuth } from '@/hooks/useAuth';
import { openUI } from '@/lib/uiEvents';
import { cn } from '@/lib/utils';

type FeatureType = 'chat' | 'interpret' | 'boards' | 'docuslp' | 'overview' | 'students' | 'progress' | 'settings';

type SidebarProps = {
  isCollapsed?: boolean;
  position?: 'left' | 'right';
};

export function Sidebar({ isCollapsed = false, position = 'left' }: SidebarProps) {
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const { t, isRTL } = useLanguage();
  const { activeFeature, setActiveFeature } = useFeaturePanel();
  const { student, students } = useStudent();

  // Core workspace items (original features)
  const coreWorkspaceItems = [
    {
      icon: BookOpen,
      labelKey: 'nav.main',
      feature: 'chat' as FeatureType,
      testId: 'nav-main',
    },
    {
      icon: MessageSquarePlus,
      labelKey: 'nav.interpret',
      feature: 'interpret' as FeatureType,
      testId: 'nav-interpret',
    },
    {
      icon: FolderOpen,
      labelKey: 'nav.boards',
      feature: 'boards' as FeatureType,
      testId: 'nav-boards',
    },
    {
      icon: LayoutGrid,
      labelKey: 'nav.docuslp',
      feature: 'docuslp' as FeatureType,
      testId: 'nav-docuslp',
    },
  ];

  // Student management items
  const studentManagementItems = [
    {
      icon: BarChart3,
      labelKey: 'nav.overview',
      feature: 'overview' as FeatureType,
      testId: 'nav-overview',
      badge: undefined as string | undefined,
    },
    {
      icon: Users,
      labelKey: 'nav.students',
      feature: 'students' as FeatureType,
      testId: 'nav-students',
      badge: students.length > 0 ? students.length.toString() : undefined,
    },
    {
      icon: ClipboardList,
      labelKey: 'nav.progress',
      feature: 'progress' as FeatureType,
      testId: 'nav-progress',
      disabled: !student, // Only enabled when a student is selected
    },
  ];

  const positionClasses = position === 'right' 
    ? 'right-0 border-l' 
    : 'left-0 border-r';

  const renderNavItem = (item: typeof coreWorkspaceItems[0] & { badge?: string; disabled?: boolean }) => {
    const isActive = activeFeature === item.feature;
    const isDisabled = 'disabled' in item && item.disabled;
    
    return (
      <Button
        key={item.labelKey}
        variant={isActive ? "secondary" : "ghost"}
        size="sm"
        disabled={isDisabled}
        className={cn(
          "w-full hover-elevate active-elevate-2",
          isDisabled && "opacity-50 cursor-not-allowed",
          isCollapsed ? "justify-center px-0" : "justify-start"
        )}
        data-testid={item.testId}
        onClick={() => !isDisabled && setActiveFeature(item.feature)}
      >
        <item.icon className="w-4 h-4" />
        {!isCollapsed && (
          <>
            <span className="">{t(item.labelKey)}</span>
            {'badge' in item && item.badge && (
              <Badge variant="secondary" className="text-xs px-1.5 py-0 h-5 ms-auto">
                {item.badge}
              </Badge>
            )}
          </>
        )}
      </Button>
    );
  };

  return (
    <div 
      dir={isRTL ? 'rtl' : 'ltr'}
      className={cn(
        "fixed top-0 h-screen bg-sidebar border-sidebar-border flex flex-col transition-all duration-300",
        positionClasses,
        isCollapsed ? "w-20" : "w-80"
      )}
    >
      {/* Logo */}
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
              <h1 
                className="text-2xl font-semibold text-sidebar-foreground leading-8"
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
          <div className="px-6 pb-4">
            <div 
              className="bg-card border border-card-border rounded-md p-4" 
              data-testid="card-client-context"
            >
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center">
                  <User className="w-5 h-5 text-primary" />
                </div>
                <div>
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
        </>
      )}

      {/* Current Student Context */}
      {!isCollapsed && student && (
        <div className="px-6 pb-4">
          <div 
            className={cn(
              "bg-primary/5 border border-primary/20 rounded-md p-3 cursor-pointer hover:bg-primary/10 transition-colors",
              "group"
            )}
            onClick={() => setActiveFeature('progress')}
            data-testid="card-student-context"
          >
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center">
                <GraduationCap className="w-4 h-4 text-primary" />
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-primary">
                  {student.name}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t('nav.currentStudent')}
                </p>
              </div>
              <ChevronRight className="w-4 h-4 text-primary/50 group-hover:text-primary transition-colors" />
            </div>
          </div>
        </div>
      )}

      <Separator className="" />

      {/* Core Navigation */}
      <div className={cn("py-4 space-y-3 flex-shrink-0", isCollapsed ? "px-2" : "px-6")}>
        {!isCollapsed && (
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
            {t('nav.workspace')}
          </p>
        )}
        
        <div className="space-y-1">
          {coreWorkspaceItems.map(renderNavItem)}
        </div>
      </div>

      <Separator className="" />

      {/* Student Management Navigation */}
      <div className={cn("py-4 space-y-3 flex-1", isCollapsed ? "px-2" : "px-6")}>
        {!isCollapsed && (
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
            {t('nav.studentManagement')}
          </p>
        )}
        
        <div className="space-y-1">
          {studentManagementItems.map(renderNavItem)}
        </div>
      </div>

      <Separator className="" />

      {/* Bottom section */}
      <div className={cn("py-6 space-y-3", isCollapsed ? "px-2" : "px-6")}>
        {/* Theme toggle */}
        {!isCollapsed ? (
          <Button
            variant="ghost"
            size="sm"
            className="w-full justify-start hover-elevate active-elevate-2"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            data-testid="button-theme"
          >
            {theme === "dark" ? (
              <Moon className="w-4 h-4 shrink-0" />
            ) : (
              <Sun className="w-4 h-4 shrink-0" />
            )}
            <span className="">{t('settings.darkMode')}</span>
            <Switch
              checked={theme === "dark"}
              className="ms-auto"
              onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
              data-testid="switch-theme"
            />
          </Button>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="w-full justify-center px-0 hover-elevate active-elevate-2"
            onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
            data-testid="button-theme-collapsed"
            title={t('settings.darkMode')}
          >
            {theme === "dark" ? (
              <Moon className="w-4 h-4" />
            ) : (
              <Sun className="w-4 h-4" />
            )}
          </Button>
        )}

        {/* Settings */}
        <Button
          variant={activeFeature === 'settings' ? "secondary" : "ghost"}
          size="sm"
          className={cn(
            "w-full hover-elevate active-elevate-2",
            isCollapsed ? "justify-center px-0" : "justify-start"
          )}
          data-testid="button-settings"
          onClick={() => setActiveFeature('settings')}
          title={isCollapsed ? t('nav.settings') : undefined}
        >
          <Settings className="w-4 h-4" />
          {!isCollapsed && <span className="">{t('nav.settings')}</span>}
        </Button>

        {/* Logout */}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "w-full hover-elevate active-elevate-2",
            isCollapsed ? "justify-center px-0" : "justify-start"
          )}
          data-testid="button-logout"
          onClick={logout}
          title={isCollapsed ? t('auth.logout') : undefined}
        >
          <LogOut className="w-4 h-4" />
          {!isCollapsed && <span className="">{t('auth.logout')}</span>}
        </Button>
      </div>
    </div>
  );
}