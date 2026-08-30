// src/components/admin/AdminSidebar.tsx
// Sidebar for admin interface

import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useTheme } from '@/contexts/ThemeContext';
import { useLanguage } from '@/contexts/LanguageContext';
import {
  Bot,
  BookOpen,
  Volume2,
  Cpu,
  History,
  DollarSign,
  Moon,
  Sun,
  Mail,
  KeyRound,
  ClipboardList,
  ShieldCheck,
  ShieldAlert,
  LogOut,
  Sparkles,
  Image as ImageIcon,
  MessageCircle,
  Users as UsersIcon,
} from 'lucide-react';
import logoImage from '@assets/aivota_icon.png';
import { cn } from '@/lib/utils';
import { useLocation } from 'wouter';
import { useAuth } from '@/hooks/useAuth';
import { hasAdminSection, type AdminSection } from '@shared/admin-sections';

type AdminSidebarProps = {
  // Null briefly during the redirect from `/admin` (no section in URL) to the
  // first permitted section — no item is highlighted in that window.
  activeSection: AdminSection | null;
  onSectionChange: (section: AdminSection) => void;
};

export function AdminSidebar({ activeSection, onSectionChange }: AdminSidebarProps) {
  const { theme, setTheme } = useTheme();
  const { t, isRTL } = useLanguage();
  const { user, logout } = useAuth();
  const [, navigate] = useLocation();

  const allNavItems = [
    {
      icon: Bot,
      label: t('admin.sections.personas'),
      section: 'personas' as AdminSection,
      testId: 'admin-nav-personas',
    },
    {
      icon: BookOpen,
      label: t('admin.sections.library'),
      section: 'library' as AdminSection,
      testId: 'admin-nav-library',
    },
    {
      icon: ImageIcon,
      label: t('admin.sections.public-symbols'),
      section: 'public-symbols' as AdminSection,
      testId: 'admin-nav-public-symbols',
    },
    {
      icon: Volume2,
      label: t('admin.sections.voices'),
      section: 'voices' as AdminSection,
      testId: 'admin-nav-voices',
    },
    {
      icon: ClipboardList,
      label: t('admin.sections.activity-log'),
      section: 'activity-log' as AdminSection,
      testId: 'admin-nav-activity-log',
    },
    {
      icon: ShieldAlert,
      label: t('admin.sections.security-incidents'),
      section: 'security-incidents' as AdminSection,
      testId: 'admin-nav-security-incidents',
    },
    {
      icon: History,
      label: t('admin.sections.sessions'),
      section: 'sessions' as AdminSection,
      testId: 'admin-nav-sessions',
    },
    {
      icon: DollarSign,
      label: t('admin.sections.cost-usage'),
      section: 'cost-usage' as AdminSection,
      testId: 'admin-nav-cost-usage',
    },
    {
      icon: Sparkles,
      label: t('admin.sections.deep-analyses'),
      section: 'deep-analyses' as AdminSection,
      testId: 'admin-nav-deep-analyses',
    },
    {
      icon: Cpu,
      label: t('admin.sections.models'),
      section: 'models' as AdminSection,
      testId: 'admin-nav-models',
    },
    {
      icon: Mail,
      label: t('admin.sections.contacts'),
      section: 'contacts' as AdminSection,
      testId: 'admin-nav-contacts',
    },
    {
      icon: MessageCircle,
      label: t('admin.sections.crm'),
      section: 'crm' as AdminSection,
      testId: 'admin-nav-crm',
    },
    {
      icon: KeyRound,
      label: t('admin.sections.licenses'),
      section: 'licenses' as AdminSection,
      testId: 'admin-nav-licenses',
    },
    {
      icon: ShieldCheck,
      label: t('admin.sections.identity-providers'),
      section: 'identity-providers' as AdminSection,
      testId: 'admin-nav-identity-providers',
    },
    {
      icon: UsersIcon,
      label: t('admin.sections.admins'),
      section: 'admins' as AdminSection,
      testId: 'admin-nav-admins',
    },
  ];

  // Filter by the current admin's permissions. Sessions that came from a
  // regular user (e.g. an institute admin who somehow lands here) have no
  // adminPermissions and see no sections — they shouldn't be on this page.
  const adminPermissions = user?.adminPermissions;
  const navItems = allNavItems.filter((item) =>
    hasAdminSection(adminPermissions, item.section),
  );

  const renderNavItem = (item: typeof navItems[0]) => {
    const isActive = activeSection === item.section;

    return (
      <Button
        key={item.section}
        variant={isActive ? "secondary" : "ghost"}
        size="sm"
        className={cn(
          "w-full hover-elevate active-elevate-2 justify-start"
        )}
        data-testid={item.testId}
        onClick={() => onSectionChange(item.section)}
      >
        <item.icon className="w-4 h-4" />
        <span className="ms-2">{item.label}</span>
      </Button>
    );
  };

  return (
    <div
      dir={isRTL ? 'rtl' : 'ltr'}
      className={cn(
        "fixed top-0 h-screen bg-sidebar border-sidebar-border flex flex-col transition-all duration-300 z-10",
        "start-0 border-e w-64"
      )}
    >
      {/* Logo */}
      <div className="flex items-center gap-2 p-4">
        <img
          src={logoImage}
          alt="CliniAACian"
          className="w-10 h-10"
        />
        <div className="flex flex-col">
          <span className="text-lg font-semibold text-foreground">CliniAACian</span>
          <span className="text-xs text-muted-foreground">System Admin</span>
        </div>
      </div>

      <Separator />

      {/* Navigation Items */}
      <nav className="flex-1 p-2 space-y-1">
        {navItems.map(renderNavItem)}
      </nav>

      <Separator />

      {/* Footer with theme toggle */}
      <div className="p-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start"
          onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
        >
          {theme === 'dark' ? (
            <Sun className="w-4 h-4" />
          ) : (
            <Moon className="w-4 h-4" />
          )}
          <span className="ms-2">
            {theme === 'dark' ? 'Light Mode' : 'Dark Mode'}
          </span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-destructive hover:text-destructive"
          onClick={() => logout()}
        >
          <LogOut className="w-4 h-4" />
          <span className="ms-2">{t('auth.logout')}</span>
        </Button>
      </div>
    </div>
  );
}
