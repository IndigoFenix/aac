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
  ChevronDown,
  Building2,
  MessageSquare,
  Image,
  Images,
  CalendarDays,
  MapPin,
  MessageCircleQuestion,
  MessagesSquare,
  Gamepad2,
  Package as PackageIcon,
  Sparkles,
  Contact,
  UserCircle,
  Share2,
  Receipt,
  Captions,
  Phone,
  MonitorDown,
} from 'lucide-react';
import { apiUrl } from '@/lib/queryClient';
import { useState } from 'react';
import logoImage from '@assets/aivota_icon.png';
import { useAuth } from '@/hooks/useAuth';
import { useInstitute } from '@/hooks/useInstitute';
import { openUI } from '@/lib/uiEvents';
import { cn } from '@/lib/utils';
import { FeatureType } from '@shared/schema';
import { FeedbackDialog } from '@/components/FeedbackDialog';
import { useStudentLabel } from '@/hooks/useStudentLabel';
import { usePersonChat } from '@/features/personChat/PersonChatContext';
import { ReviewTimeIndicator } from '@/components/insurance/ReviewTimeIndicator';

type SidebarProps = {
  isCollapsed?: boolean;
  position?: 'left' | 'right';
  isMobile?: boolean;
  onNavigate?: () => void;
};

export function Sidebar({ isCollapsed: isCollapsedProp = false, position = 'left', isMobile = false, onNavigate }: SidebarProps) {
  // On mobile, always show expanded sidebar
  const isCollapsed = isMobile ? false : isCollapsedProp;
  const [feedbackOpen, setFeedbackOpen] = useState(false);

  // Each nav section (Workspace / AAC Boards / Student Management) can be
  // collapsed independently. Persisted so the layout survives a reload; only
  // meaningful when the sidebar itself isn't in icon-only mode.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => {
    try {
      const stored = localStorage.getItem('sidebar-open-sections');
      return stored ? JSON.parse(stored) : {};
    } catch {
      return {};
    }
  });
  const isSectionOpen = (section: string) => openSections[section] !== false;
  const toggleSection = (section: string) => {
    setOpenSections((prev) => {
      const next = { ...prev, [section]: !isSectionOpen(section) };
      try {
        localStorage.setItem('sidebar-open-sections', JSON.stringify(next));
      } catch {
        // Storage may be unavailable (e.g. private browsing) — collapse state just won't persist.
      }
      return next;
    });
  };
  const { user, logout } = useAuth();
  const { theme, setTheme } = useTheme();
  const { t, isRTL } = useLanguage();
  const { ts } = useStudentLabel();
  const { activeFeature, setActiveFeature } = useFeaturePanel();
  const { student, students } = useStudent();
  const { currentInstitute, currentPermissions, institutes } = useInstitute();

  // Use institution logo if available, otherwise default CliniAACian logo
  const displayLogo = currentInstitute?.logoUrl || logoImage;
  const displayName = currentInstitute?.name || 'CliniAACian';

  const perms = currentPermissions;
  const hasInstitute = institutes.length > 0;
  const maxStudents = perms?.maxStudents ?? 0;
  const { totalUnread } = usePersonChat();
  const personChatUnreadBadge = totalUnread > 0 ? String(totalUnread) : undefined;
  const hasStudentAccess = maxStudents === -1 || maxStudents > 0;

  // ── Section 1: Workspace ──
  const workspaceItems = [
    {
      icon: BarChart3,
      labelKey: 'nav.overview',
      feature: 'overview' as FeatureType,
      testId: 'nav-overview',
      badge: undefined as string | undefined,
    },
    // Institute — only if user belongs to at least one
    ...(hasInstitute ? [{
      icon: Building2,
      labelKey: 'nav.institute',
      feature: 'institute' as FeatureType,
      testId: 'nav-institute',
      badge: undefined as string | undefined,
    }] : []),
    {
      icon: Users,
      labelKey: 'nav.students',
      feature: 'students' as FeatureType,
      testId: 'nav-students',
      badge: students.length > 0 ? students.length.toString() : undefined,
    },
    ...(perms?.calendar ? [{
      icon: CalendarDays,
      labelKey: 'nav.calendar',
      feature: 'calendar' as FeatureType,
      testId: 'nav-calendar',
      badge: undefined as string | undefined,
    }] : []),
    ...(hasInstitute ? [{
      icon: MapPin,
      labelKey: 'nav.locations',
      feature: 'locations' as FeatureType,
      testId: 'nav-locations',
      badge: undefined as string | undefined,
    }] : []),
    ...(hasInstitute ? [{
      icon: MessagesSquare,
      labelKey: 'nav.personChat',
      feature: 'userchat' as FeatureType,
      testId: 'nav-userchat',
      badge: personChatUnreadBadge,
    }] : []),
    ...(hasInstitute ? [{
      icon: Phone,
      labelKey: 'nav.call',
      feature: 'call' as FeatureType,
      testId: 'nav-call',
      badge: undefined as string | undefined,
    }] : []),
  ];
  // Hide Workspace entirely if user has no institutes AND maxStudents=0
  const showWorkspace = hasInstitute || hasStudentAccess;

  // ── Section 2: AAC ──
  const boardsEnabled = !!perms?.boardMakerEnabled;
  const aacEnabled = !!perms?.aacEnabled;
  const customAppsEnabled = !!perms?.customAppsEnabled;
  const videoCaptionEnabled = !!perms?.videoCaptionEnabled;
  const showAacSection = boardsEnabled || aacEnabled || customAppsEnabled || videoCaptionEnabled || !!perms?.packagesEnabled;

  const aacBoardItems = [
    // Generate AAC Boards — requires boardMakerEnabled
    ...(boardsEnabled ? [{
      icon: LayoutGrid,
      labelKey: 'nav.boards',
      feature: 'boards' as FeatureType,
      testId: 'nav-boards',
      badge: undefined as string | undefined,
    }] : []),
    // Symbol Library — requires boardMakerEnabled OR aacEnabled
    ...((boardsEnabled || aacEnabled) ? [{
      icon: Image,
      labelKey: 'nav.symbols',
      feature: 'symbols' as FeatureType,
      testId: 'nav-symbols',
      badge: undefined as string | undefined,
    }] : []),
    // Family Photos — same gate as the symbol library: it is AAC board content.
    ...((boardsEnabled || aacEnabled) ? [{
      icon: Images,
      labelKey: 'nav.photos',
      feature: 'photos' as FeatureType,
      testId: 'nav-photos',
      badge: undefined as string | undefined,
    }] : []),
    // Custom apps / games — gated on customAppsEnabled license permission
    ...(perms?.customAppsEnabled ? [{
      icon: Gamepad2,
      labelKey: 'nav.customApps',
      feature: 'customApps' as FeatureType,
      testId: 'nav-custom-apps',
      badge: undefined as string | undefined,
    }] : []),
    // Content packages — gated on packagesEnabled. Bundles of boards shared
    // across an institute and attachable to students.
    ...(perms?.packagesEnabled ? [{
      icon: PackageIcon,
      labelKey: 'nav.packages',
      feature: 'packages' as FeatureType,
      testId: 'nav-packages',
      badge: undefined as string | undefined,
    }] : []),
    // AAC Settings — requires aacEnabled AND maxStudents > 0
    ...(aacEnabled && hasStudentAccess ? [{
      icon: Settings,
      labelKey: 'nav.aacSettings',
      feature: 'aacsettings' as FeatureType,
      testId: 'nav-aacsettings',
      disabled: !student,
      badge: undefined as string | undefined,
    }] : []),
    // Video Caption Studio — gated on videoCaptionEnabled license permission
    ...(videoCaptionEnabled ? [{
      icon: Captions,
      labelKey: 'nav.videoCaption',
      feature: 'videoCaption' as FeatureType,
      testId: 'nav-video-caption',
      badge: undefined as string | undefined,
    }] : []),
    // App downloads (Windows installer + iPad .ipa) — anyone licensed for the
    // AAC needs to be able to install it. Deliberately NOT student-scoped, so
    // unlike AAC Settings it stays available with no student selected.
    ...(aacEnabled ? [{
      icon: MonitorDown,
      labelKey: 'nav.downloads',
      feature: 'downloads' as FeatureType,
      testId: 'nav-downloads',
      badge: undefined as string | undefined,
    }] : []),
  ];

  // ── Section 3: Student Management ──
  // Visible whenever the license allows at least one student.
  const dashboardLevel = perms?.dashboardLevel ?? 0;
  const showProgressItems = dashboardLevel === -1 || dashboardLevel > 0;
  const showStudentMgmt = hasStudentAccess;

  const deepAnalysisEnabled = !!perms?.deepAnalysisEnabled;

  const studentMgmtItems = [
    {
      icon: UserCircle,
      labelKey: 'nav.studentInfo',
      feature: 'studentInfo' as FeatureType,
      testId: 'nav-student-info',
      disabled: !student,
      badge: undefined as string | undefined,
    },
    ...(showProgressItems ? [{
      icon: ClipboardList,
      labelKey: 'nav.progress',
      feature: 'progress' as FeatureType,
      testId: 'nav-progress',
      disabled: !student,
      badge: undefined as string | undefined,
    }] : []),
    {
      icon: Contact,
      labelKey: 'nav.contacts',
      feature: 'contacts' as FeatureType,
      testId: 'nav-contacts',
      disabled: !student,
      badge: undefined as string | undefined,
    },
    ...(showProgressItems ? [{
      icon: ClipboardList,
      labelKey: 'nav.reports',
      feature: 'reports' as FeatureType,
      testId: 'nav-reports',
      disabled: !student,
      badge: undefined as string | undefined,
    }] : []),
    ...(deepAnalysisEnabled && showProgressItems ? [{
      icon: Sparkles,
      labelKey: 'nav.deepAnalysis',
      feature: 'deepAnalysis' as FeatureType,
      testId: 'nav-deep-analysis',
      disabled: !student,
      badge: undefined as string | undefined,
    }] : []),
    {
      icon: Share2,
      labelKey: 'nav.shares',
      feature: 'shares' as FeatureType,
      testId: 'nav-shares',
      disabled: false,
      badge: undefined as string | undefined,
    },
    ...(perms?.insuranceBridgeEnabled ? [{
      icon: Receipt,
      labelKey: 'nav.insuranceBridge',
      feature: 'insuranceBridge' as FeatureType,
      testId: 'nav-insurance-bridge',
      disabled: false,
      badge: undefined as string | undefined,
    }] : []),
  ];

  const positionClasses = position === 'right' 
    ? 'right-0 border-l' 
    : 'left-0 border-r';

  const renderNavItem = (item: typeof workspaceItems[0] & { badge?: string; disabled?: boolean }) => {
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
        onClick={() => {
          if (!isDisabled) {
            setActiveFeature(item.feature);
            onNavigate?.();
          }
        }}
      >
        <item.icon className="w-4 h-4" />
        {!isCollapsed && (
          <>
            <span className="">{ts(item.labelKey)}</span>
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

  const renderSectionHeader = (section: string, label: string) => {
    const isOpen = isSectionOpen(section);
    return (
      <button
        type="button"
        className="w-full flex items-center justify-between gap-2 mb-3 min-h-8 rounded-md -mx-2 px-2 hover-elevate active-elevate-2"
        onClick={() => toggleSection(section)}
        aria-expanded={isOpen}
        data-testid={`button-toggle-section-${section}`}
      >
        <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
          {label}
        </p>
        <ChevronDown
          className={cn(
            "w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform duration-200",
            isOpen && "rotate-180"
          )}
        />
      </button>
    );
  };

  // Animates the item list open/closed by tweening its grid row from 0fr to 1fr
  // (rather than mounting/unmounting), so collapsing a section reads as a slide
  // rather than an instant jump. Icon-only mode ignores section state — there's
  // no header to toggle it, so every item stays visible.
  const renderSectionBody = (section: string, items: (typeof workspaceItems)[number][]) => {
    const open = isCollapsed || isSectionOpen(section);
    return (
      <div
        className={cn(
          "grid transition-[grid-template-rows] duration-200 ease-out",
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        )}
      >
        <div className="overflow-hidden">
          <div
            className={cn(
              "space-y-1 transition-opacity duration-200",
              open ? "opacity-100" : "opacity-0"
            )}
          >
            {items.map(renderNavItem)}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div
      dir={isRTL ? 'rtl' : 'ltr'}
      className={cn(
        "top-0 bg-sidebar border-sidebar-border flex flex-col transition-all duration-300 overflow-y-auto",
        isMobile ? "h-full w-80" : "fixed h-screen",
        !isMobile && positionClasses,
        !isMobile && (isCollapsed ? "w-20" : "w-80")
      )}
    >
      {/* Logo — real <button> so it's keyboard-reachable and announces
          correctly to screen readers (WCAG 2.1.1). */}
      <button
        type="button"
        className="p-6 w-full text-start cursor-pointer rounded-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        onClick={() => { setActiveFeature('chat' as FeatureType); onNavigate?.(); }}
        aria-label={t('nav.home') || 'Go to home'}
      >
        {!isCollapsed ? (
          <div className="flex items-start gap-3">
            <img
              src={displayLogo}
              alt={displayName}
              className="w-8 h-8 flex-shrink-0 rounded"
              data-testid="img-logo"
            />
            <div className="flex-1">
              <h1
                className="text-2xl font-semibold text-sidebar-foreground leading-8 truncate"
                data-testid="text-logo"
              >
                {displayName}
              </h1>
            </div>
          </div>
        ) : (
          <div className="flex justify-center" data-testid="logo-collapsed">
            <img
              src={displayLogo}
              alt={displayName}
              className="w-8 h-8 rounded"
              data-testid="img-logo-collapsed"
            />
          </div>
        )}
      </button>

      {/* Current Student Context */}
      {hasStudentAccess && (
        !isCollapsed && (
          <div className="px-6 pb-4">
            <button
              type="button"
              className={cn(
                "w-full text-start bg-primary/5 border border-primary/20 rounded-md p-3 cursor-pointer hover:bg-primary/10 transition-colors",
                "group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              )}
              onClick={() => { if (student) { setActiveFeature('progress'); onNavigate?.(); } }}
              data-testid="card-student-context"
              aria-label={student ? `Open progress for ${student.firstName ?? "current student"}` : undefined}
            > {student ? (
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center overflow-hidden">
                  {(student as any).biometricDataId ? (
                    <img
                      src={apiUrl(`/api/biometric-data/${(student as any).biometricDataId}/photo`)}
                      alt={student.name}
                      className="w-full h-full object-cover"
                      onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                    />
                  ) : (
                    <GraduationCap className="w-4 h-4 text-primary" />
                  )}
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-primary">
                    {student.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {t('nav.currentStudent')}
                  </p>
                  <ReviewTimeIndicator
                    enabled={!!perms?.insuranceBridgeEnabled}
                    instituteId={currentInstitute?.id ?? null}
                    studentId={student.id}
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-full bg-primary/20 flex items-center justify-center">
                  <GraduationCap className="w-4 h-4 text-primary" />
                </div>
                <div className="flex-1">
                  <p className="text-sm font-medium text-primary">
                    {t('nav.noStudentSelected')}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    ---
                  </p>
                </div>
              </div>
            )}
            </button>
          </div>
        )
      )}

      <Separator className="" />

      {/* Workspace */}
      {showWorkspace && (
        <>
          <div className={cn("py-4 space-y-3 flex-shrink-0", isCollapsed ? "px-2" : "px-6")}>
            {!isCollapsed && renderSectionHeader('workspace', t('nav.workspace'))}
            {renderSectionBody('workspace', workspaceItems)}
          </div>
          <Separator className="" />
        </>
      )}

      {/* AAC */}
      {showAacSection && (
        <>
          <div className={cn("py-4 space-y-3 flex-shrink-0", isCollapsed ? "px-2" : "px-6")}>
            {!isCollapsed && renderSectionHeader('aacBoards', t('nav.aacBoards'))}
            {renderSectionBody('aacBoards', aacBoardItems)}
          </div>
          <Separator className="" />
        </>
      )}

      {/* Student Management */}
      {showStudentMgmt && (
        <>
          <div className={cn("py-4 space-y-3 flex-shrink-0", isCollapsed ? "px-2" : "px-6")}>
            {!isCollapsed && renderSectionHeader('studentMgmt', ts('nav.studentManagement'))}
            {renderSectionBody('studentMgmt', studentMgmtItems)}
          </div>
          <Separator className="" />
        </>
      )}

      {/* Spacer to push bottom section down */}
      <div className="flex-1" />

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
          onClick={() => { setActiveFeature('settings'); onNavigate?.(); }}
          title={isCollapsed ? t('nav.settings') : undefined}
        >
          <Settings className="w-4 h-4" />
          {!isCollapsed && <span className="">{t('nav.settings')}</span>}
        </Button>

        {/* Feedback / Bug Report */}
        <Button
          variant="ghost"
          size="sm"
          className={cn(
            "w-full hover-elevate active-elevate-2",
            isCollapsed ? "justify-center px-0" : "justify-start"
          )}
          onClick={() => setFeedbackOpen(true)}
          title={isCollapsed ? (t('feedback.title') || 'Send Feedback') : undefined}
        >
          <MessageCircleQuestion className="w-4 h-4" />
          {!isCollapsed && <span>{t('feedback.title') || 'Send Feedback'}</span>}
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

      <FeedbackDialog open={feedbackOpen} onClose={() => setFeedbackOpen(false)} />
    </div>
  );
}