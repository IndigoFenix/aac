// src/components/layout/TopHeader.tsx
import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { User, Menu, Settings, LogOut, LogIn, Shield } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useStudent } from '@/hooks/useStudent';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { LanguageSelector } from '@/components/LanguageSelector';
import { openUI } from '@/lib/uiEvents';
import { cn } from '@/lib/utils';

type TopHeaderProps = {
  onToggleSidebar?: () => void;
};

export function TopHeader({ onToggleSidebar }: TopHeaderProps) {
  const { user, isAuthenticated, isLoading, logout } = useAuth();
  const { student, students, isLoading: isStudentLoading, selectStudent } = useStudent();
  const { t, isRTL } = useLanguage();
  const { activeFeature } = useFeaturePanel();

  const getHeaderTitle = (): string => {
    switch (activeFeature) {
      case 'boards':
        return t('nav.boards');
      case 'interpret':
        return t('nav.interpret');
      case 'docuslp':
        return t('nav.docuslp');
      default:
        return t('header.title');
    }
  };

  return (
    <header className="h-16 border-b border-border bg-background px-4 sm:px-6 flex items-center justify-between">
      {/* Start side - Menu and title */}
      <div className="flex items-center gap-2">
        <Button
          variant="ghost"
          size="icon"
          onClick={onToggleSidebar}
          data-testid="button-toggle-sidebar"
          className="hover-elevate active-elevate-2"
          aria-label={t('nav.toggleSidebar')}
        >
          <Menu className="w-5 h-5" />
        </Button>
        <span className="text-sm sm:text-base font-medium">{getHeaderTitle()}</span>
      </div>

      {/* End side - Controls */}
      <div className="flex items-center gap-2 sm:gap-3">
        {/* Student selector */}
        {isAuthenticated && user && (
          <div className="flex items-center gap-2">
            <label
              htmlFor="student-selector"
              className="hidden sm:inline text-xs text-muted-foreground"
            >
              {t('header.student')}
            </label>
            <select
              id="student-selector"
              className={cn(
                "max-w-[180px] text-xs sm:text-sm border border-input bg-background rounded-md px-2 py-1",
                "focus:outline-none focus:ring-2 focus:ring-primary"
              )}
              dir="auto"
              value={student?.id ?? ''}
              disabled={isStudentLoading || !students.length}
              onChange={(event) => {
                const selectedId = event.target.value;
                void selectStudent(selectedId || undefined);
              }}
            >
              <option value="">
                {isStudentLoading
                  ? t('header.loadingStudents')
                  : students.length
                  ? t('header.selectStudent')
                  : t('header.noStudents')}
              </option>
              {students.map((u) => (
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
            <div className="hidden sm:flex items-center gap-1 text-xs text-muted-foreground">
              <span className="font-medium text-foreground">{user.credits}</span>
              <span>{t('header.credits')}</span>
            </div>

            {/* Admin portal */}
            {(user.userType === 'admin' || user.isAdmin) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => (window.location.href = '/admin')}
                className="text-xs px-2 py-1 bg-amber-50 border-amber-200 text-amber-700 hover:bg-amber-100"
                data-testid="button-admin"
                aria-label={t('header.admin')}
              >
                <Shield className="w-4 h-4" />
              </Button>
            )}

            {/* Profile, Settings, Logout */}
            <div className="flex items-center gap-2">
              <div className="hidden sm:block text-end">
                <p className="text-sm font-medium text-foreground">
                  {user.firstName || 'User'}
                </p>
                <p className="text-xs text-muted-foreground">{t('header.active')}</p>
              </div>
              <Avatar className="w-8 h-8">
                <AvatarFallback className="bg-primary/10">
                  <User className="w-4 h-4 text-primary" />
                </AvatarFallback>
              </Avatar>
              <Button
                variant="ghost"
                size="icon"
                onClick={() => openUI('settings')}
                aria-label={t('nav.settings')}
              >
                <Settings className="w-4 h-4" />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                onClick={logout}
                aria-label={t('auth.logout')}
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
              onClick={() => openUI('login')}
              className="p-1.5"
              title={t('auth.login')}
              data-testid="button-login"
            >
              <LogIn className="w-4 h-4" />
            </Button>
          )
        )}

        {/* Language */}
        <LanguageSelector />
      </div>
    </header>
  );
}