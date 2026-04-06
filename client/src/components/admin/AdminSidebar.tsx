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
  ArrowLeft,
  Moon,
  Sun,
  Mail,
  KeyRound,
  ClipboardList,
  ShieldCheck,
  LogOut,
} from 'lucide-react';
import logoImage from '@assets/aivota_icon.png';
import { cn } from '@/lib/utils';
import { useLocation } from 'wouter';
import { useAuth } from '@/hooks/useAuth';

type AdminSection = 'personas' | 'library' | 'voices' | 'models' | 'sessions' | 'contacts' | 'licenses' | 'identity-providers' | 'activity-log';

type AdminSidebarProps = {
  activeSection: AdminSection;
  onSectionChange: (section: AdminSection) => void;
};

export function AdminSidebar({ activeSection, onSectionChange }: AdminSidebarProps) {
  const { theme, setTheme } = useTheme();
  const { t, isRTL } = useLanguage();
  const { logout } = useAuth();
  const [, navigate] = useLocation();

  const navItems = [
    {
      icon: Bot,
      label: 'Agents',
      section: 'personas' as AdminSection,
      testId: 'admin-nav-personas',
    },
    {
      icon: BookOpen,
      label: 'Library',
      section: 'library' as AdminSection,
      testId: 'admin-nav-library',
    },
    {
      icon: Volume2,
      label: 'Voices',
      section: 'voices' as AdminSection,
      testId: 'admin-nav-voices',
    },
    {
      icon: Cpu,
      label: 'AI Models',
      section: 'models' as AdminSection,
      testId: 'admin-nav-models',
    },
    {
      icon: History,
      label: 'Sessions',
      section: 'sessions' as AdminSection,
      testId: 'admin-nav-sessions',
    },
    {
      icon: Mail,
      label: 'Contacts',
      section: 'contacts' as AdminSection,
      testId: 'admin-nav-contacts',
    },
    {
      icon: KeyRound,
      label: 'Licenses',
      section: 'licenses' as AdminSection,
      testId: 'admin-nav-licenses',
    },
    {
      icon: ShieldCheck,
      label: 'Identity Providers',
      section: 'identity-providers' as AdminSection,
      testId: 'admin-nav-identity-providers',
    },
    {
      icon: ClipboardList,
      label: 'Activity Log',
      section: 'activity-log' as AdminSection,
      testId: 'admin-nav-activity-log',
    },
  ];

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

      {/* Back to Dashboard */}
      <div className="p-2">
        <Button
          variant="ghost"
          size="sm"
          className="w-full justify-start text-muted-foreground hover:text-foreground"
          onClick={() => navigate('/overview')}
        >
          <ArrowLeft className="w-4 h-4 mirror-rtl" />
          <span className="ms-2">Back to Dashboard</span>
        </Button>
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
