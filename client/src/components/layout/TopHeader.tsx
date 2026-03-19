// src/components/layout/TopHeader.tsx

import { Button } from '@/components/ui/button';
import { Avatar, AvatarFallback } from '@/components/ui/avatar';
import { User, Menu, Settings, LogOut, Shield, Building2 } from 'lucide-react';
import { useAuth } from '@/hooks/useAuth';
import { useStudent } from '@/hooks/useStudent';
import { useInstitute } from '@/hooks/useInstitute';
import { useLanguage } from '@/contexts/LanguageContext';
import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { LanguageSelector } from '@/components/LanguageSelector';
import { openUI } from '@/lib/uiEvents';
import { cn } from '@/lib/utils';

type TopHeaderProps = {
  onToggleSidebar?: () => void;
};

export function TopHeader({ onToggleSidebar }: TopHeaderProps) {
  const { user, logout } = useAuth();
  const { student, students, isLoading: isStudentLoading, selectStudent } = useStudent();
  const { institutes, currentInstitute, selectInstitute } = useInstitute();
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
      case 'overview':
        return t('nav.overview');
      case 'institute':
        return t('nav.institute');
      case 'students':
        return t('nav.students');
      case 'aacsettings':
        return t('nav.aacsettings');
      case 'progress':
        return t('nav.progress');
      case 'reports':
        return t('nav.reports');
      default:
        return t('header.title');
    }
  };

  // Since this component is only rendered in protected routes,
  // user should always be defined here
  if (!user) {
    return null;
  }

  return (
    <header className="h-14 md:h-16 border-b border-border bg-background px-3 md:px-6 flex items-center justify-between">
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
        <span className="text-sm md:text-base font-medium truncate max-w-[120px] md:max-w-none">{getHeaderTitle()}</span>
      </div>

      {/* End side - Controls */}
      <div className="flex items-center gap-1.5 md:gap-3">
        {/* Institution selector - hidden on mobile */}
        {institutes.length > 1 && (
          <div className="hidden md:flex items-center gap-2">
            <Building2 className="w-4 h-4 text-muted-foreground" />
            <select
              id="institute-selector"
              className={cn(
                "max-w-[160px] text-sm border border-input bg-background rounded-md px-2 py-1",
                "focus:outline-none focus:ring-2 focus:ring-primary"
              )}
              dir="auto"
              value={currentInstitute?.id ?? ''}
              onChange={(event) => {
                selectInstitute(event.target.value || null);
              }}
            >
              <option value="">{t('header.selectInstitute')}</option>
              {institutes.map((inst) => (
                <option key={inst.id} value={inst.id}>{inst.name}</option>
              ))}
            </select>
          </div>
        )}

        {/* Student selector */}
        <div className="flex items-center gap-1 md:gap-2">
          <label
            htmlFor="student-selector"
            className="hidden md:inline text-xs text-muted-foreground"
          >
            {t('header.student')}
          </label>
          <select
            id="student-selector"
            className={cn(
              "max-w-[120px] md:max-w-[180px] text-xs md:text-sm border border-input bg-background rounded-md px-1.5 md:px-2 py-1",
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
            {students && students.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name}
              </option>
            ))}
          </select>
        </div>

        {/* License type badge - hidden on mobile */}
        {user.licenseType && user.licenseType !== 'none' && (
          <div className="hidden md:flex items-center gap-1 text-xs text-muted-foreground">
            <span className="font-medium text-foreground capitalize">{user.licenseType}</span>
          </div>
        )}

        {/* System Admin portal */}
        {user.isSystemAdmin && (
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
        <div className="flex items-center gap-1 md:gap-2">
          <div className="hidden md:block text-end">
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
          {/* Settings & Logout - hidden on mobile (available in sidebar) */}
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            onClick={() => openUI('settings')}
            aria-label={t('nav.settings')}
          >
            <Settings className="w-4 h-4" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="hidden md:inline-flex"
            onClick={logout}
            aria-label={t('auth.logout')}
          >
            <LogOut className="w-4 h-4" />
          </Button>
        </div>

        {/* Language - hidden on mobile (available in sidebar/settings) */}
        <div className="hidden md:block">
          <LanguageSelector />
        </div>
      </div>
    </header>
  );
}
