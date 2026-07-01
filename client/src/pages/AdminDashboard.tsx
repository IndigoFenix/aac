// src/pages/AdminDashboard.tsx
// Main admin dashboard page

import { useState, useEffect } from 'react';
import { useLocation, useRoute } from 'wouter';
import { AdminSidebar } from '@/components/admin/AdminSidebar';
import { PersonaList } from '@/components/admin/PersonaList';
import { TopicList } from '@/components/admin/TopicList';
import { TopicView } from '@/components/admin/TopicView';
import { VoiceList } from '@/components/admin/VoiceList';
import { ModelSettings } from '@/components/admin/ModelSettings';
import { SessionHistory } from '@/components/admin/SessionHistory';
import { CostUsageDashboard } from '@/components/admin/CostUsageDashboard';
import { ContactInquiries } from '@/components/admin/ContactInquiries';
import { LicenseList } from '@/components/admin/LicenseList';
import { LicenseStudents } from '@/components/admin/LicenseStudents';
import { StudentBudgetPanel } from '@/components/admin/StudentBudgetPanel';
import { ActivityLog } from '@/components/admin/ActivityLog';
import { IdentityProviderList } from '@/components/admin/IdentityProviderList';
import { DeepAnalysisAdmin } from '@/components/admin/DeepAnalysisAdmin';
import { PublicSymbolsAdmin } from '@/components/admin/PublicSymbolsAdmin';
import { CrmAdminPage } from '@/components/admin/CrmAdminPage';
import { CrmCustomerDetail } from '@/components/admin/CrmCustomerDetail';
import { AdminUsersManager } from '@/components/admin/AdminUsersManager';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/hooks/useAuth';
import { ADMIN_SECTIONS, hasAdminSection, type AdminSection } from '@shared/admin-sections';

/**
 * First section in canonical order that the admin has permission for.
 * Used to decide where to land an admin who navigates to `/admin` with no
 * section, and to redirect away from a section they can't access.
 */
function firstPermittedSection(perms: string[] | null | undefined): AdminSection | null {
  for (const section of ADMIN_SECTIONS) {
    if (hasAdminSection(perms, section)) return section;
  }
  return null;
}

export function AdminDashboard() {
  const [location, navigate] = useLocation();
  const [, params] = useRoute('/admin/library/:topicId');
  const [, crmCustomerParams] = useRoute('/admin/crm/customers/:customerId');
  const [, licenseStudentParams] = useRoute('/admin/licenses/:licenseId/students/:studentId');
  const [, licenseStudentsParams] = useRoute('/admin/licenses/:licenseId/students');
  const { direction } = useLanguage();
  const { user } = useAuth();
  const adminPermissions = user?.adminPermissions;
  const fallbackSection = firstPermittedSection(adminPermissions);

  // Determine active section from URL. Returns null if the URL is the bare
  // `/admin` (no section chosen yet) — the redirect effect below sends the
  // admin to the first section they can access.
  const getActiveSection = (): AdminSection | null => {
    if (location.startsWith('/admin/library')) return 'library';
    if (location.startsWith('/admin/voices')) return 'voices';
    if (location.startsWith('/admin/models')) return 'models';
    if (location.startsWith('/admin/sessions')) return 'sessions';
    if (location.startsWith('/admin/cost-usage')) return 'cost-usage';
    if (location.startsWith('/admin/contacts')) return 'contacts';
    if (location.startsWith('/admin/licenses')) return 'licenses';
    if (location.startsWith('/admin/identity-providers')) return 'identity-providers';
    if (location.startsWith('/admin/activity-log')) return 'activity-log';
    if (location.startsWith('/admin/deep-analyses')) return 'deep-analyses';
    if (location.startsWith('/admin/public-symbols')) return 'public-symbols';
    if (location.startsWith('/admin/crm')) return 'crm';
    if (location.startsWith('/admin/admins')) return 'admins';
    if (location.startsWith('/admin/personas')) return 'personas';
    return null;
  };

  const [activeSection, setActiveSection] = useState<AdminSection | null>(getActiveSection());

  // Update section when URL changes
  useEffect(() => {
    setActiveSection(getActiveSection());
  }, [location]);

  // If the URL lacks a section, or the admin doesn't have permission for the
  // chosen section, redirect them to the first section their permissions
  // allow. Mirrors the server-side `requireAdminSection` gate — so a
  // restricted admin never lands on a section that would 403.
  useEffect(() => {
    if (!user) return;
    const urlSection = getActiveSection();
    const needsRedirect =
      urlSection === null ||
      (adminPermissions !== undefined && !hasAdminSection(adminPermissions, urlSection));
    if (needsRedirect && fallbackSection) {
      navigate(`/admin/${fallbackSection}`);
    }
  }, [location, adminPermissions, user]);

  const handleSectionChange = (section: AdminSection) => {
    setActiveSection(section);
    if (section === 'personas') {
      navigate('/admin/personas');
    } else if (section === 'library') {
      navigate('/admin/library');
    } else if (section === 'voices') {
      navigate('/admin/voices');
    } else if (section === 'models') {
      navigate('/admin/models');
    } else if (section === 'sessions') {
      navigate('/admin/sessions');
    } else if (section === 'cost-usage') {
      navigate('/admin/cost-usage');
    } else if (section === 'contacts') {
      navigate('/admin/contacts');
    } else if (section === 'licenses') {
      navigate('/admin/licenses');
    } else if (section === 'identity-providers') {
      navigate('/admin/identity-providers');
    } else if (section === 'activity-log') {
      navigate('/admin/activity-log');
    } else if (section === 'deep-analyses') {
      navigate('/admin/deep-analyses');
    } else if (section === 'public-symbols') {
      navigate('/admin/public-symbols');
    } else if (section === 'crm') {
      navigate('/admin/crm');
    } else if (section === 'admins') {
      navigate('/admin/admins');
    }
  };

  // Get current topic ID from URL if viewing a specific topic
  const currentTopicId = params?.topicId;

  const renderContent = () => {
    if (activeSection === 'personas') {
      return <PersonaList />;
    }

    if (activeSection === 'library') {
      if (currentTopicId) {
        return <TopicView topicId={currentTopicId} />;
      }
      return <TopicList parentId={null} />;
    }

    if (activeSection === 'voices') {
      return <VoiceList />;
    }

    if (activeSection === 'models') {
      return <ModelSettings />;
    }

    if (activeSection === 'sessions') {
      return <SessionHistory />;
    }

    if (activeSection === 'cost-usage') {
      return <CostUsageDashboard />;
    }

    if (activeSection === 'contacts') {
      return <ContactInquiries />;
    }

    if (activeSection === 'licenses') {
      if (licenseStudentParams?.licenseId && licenseStudentParams?.studentId) {
        return (
          <StudentBudgetPanel
            licenseId={licenseStudentParams.licenseId}
            studentId={licenseStudentParams.studentId}
          />
        );
      }
      if (licenseStudentsParams?.licenseId) {
        return <LicenseStudents licenseId={licenseStudentsParams.licenseId} />;
      }
      return <LicenseList />;
    }

    if (activeSection === 'identity-providers') {
      return <IdentityProviderList />;
    }

    if (activeSection === 'activity-log') {
      return <ActivityLog />;
    }

    if (activeSection === 'deep-analyses') {
      return <DeepAnalysisAdmin />;
    }

    if (activeSection === 'public-symbols') {
      return <PublicSymbolsAdmin />;
    }

    if (activeSection === 'crm') {
      if (crmCustomerParams?.customerId) {
        return <CrmCustomerDetail customerId={crmCustomerParams.customerId} />;
      }
      return <CrmAdminPage />;
    }

    if (activeSection === 'admins') {
      return <AdminUsersManager />;
    }

    // Either the redirect effect is about to fire (activeSection still null),
    // or the admin truly has no permitted sections at all.
    if (activeSection === null && adminPermissions !== undefined && !fallbackSection) {
      return (
        <div className="text-muted-foreground">
          No admin sections are enabled for this account.
        </div>
      );
    }
    return null;
  };

  return (
    <div className="min-h-screen bg-background" dir={direction}>
      <AdminSidebar
        activeSection={activeSection}
        onSectionChange={handleSectionChange}
      />

      {/* Main content area - offset by sidebar width */}
      <main className={cn("ms-64 min-h-screen p-6")}>
        {renderContent()}
      </main>
    </div>
  );
}
