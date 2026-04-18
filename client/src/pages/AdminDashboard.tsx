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
import { ContactInquiries } from '@/components/admin/ContactInquiries';
import { LicenseList } from '@/components/admin/LicenseList';
import { ActivityLog } from '@/components/admin/ActivityLog';
import { IdentityProviderList } from '@/components/admin/IdentityProviderList';
import { DeepAnalysisAdmin } from '@/components/admin/DeepAnalysisAdmin';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/contexts/LanguageContext';

type AdminSection = 'personas' | 'library' | 'voices' | 'models' | 'sessions' | 'contacts' | 'licenses' | 'identity-providers' | 'activity-log' | 'deep-analyses';

export function AdminDashboard() {
  const [location, navigate] = useLocation();
  const [, params] = useRoute('/admin/library/:topicId');
  const { direction } = useLanguage();

  // Determine active section from URL
  const getActiveSection = (): AdminSection => {
    if (location.startsWith('/admin/library')) return 'library';
    if (location.startsWith('/admin/voices')) return 'voices';
    if (location.startsWith('/admin/models')) return 'models';
    if (location.startsWith('/admin/sessions')) return 'sessions';
    if (location.startsWith('/admin/contacts')) return 'contacts';
    if (location.startsWith('/admin/licenses')) return 'licenses';
    if (location.startsWith('/admin/identity-providers')) return 'identity-providers';
    if (location.startsWith('/admin/activity-log')) return 'activity-log';
    if (location.startsWith('/admin/deep-analyses')) return 'deep-analyses';
    if (location.startsWith('/admin/personas')) return 'personas';
    return 'personas'; // default
  };

  const [activeSection, setActiveSection] = useState<AdminSection>(getActiveSection());

  // Update section when URL changes
  useEffect(() => {
    setActiveSection(getActiveSection());
  }, [location]);

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

    if (activeSection === 'contacts') {
      return <ContactInquiries />;
    }

    if (activeSection === 'licenses') {
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
