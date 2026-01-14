// src/pages/AdminDashboard.tsx
// Main admin dashboard page

import { useState, useEffect } from 'react';
import { useLocation, useRoute } from 'wouter';
import { AdminSidebar } from '@/components/admin/AdminSidebar';
import { PersonaList } from '@/components/admin/PersonaList';
import { TopicList } from '@/components/admin/TopicList';
import { TopicView } from '@/components/admin/TopicView';
import { cn } from '@/lib/utils';

type AdminSection = 'personas' | 'library';

export function AdminDashboard() {
  const [location, navigate] = useLocation();
  const [, params] = useRoute('/admin/library/:topicId');

  // Determine active section from URL
  const getActiveSection = (): AdminSection => {
    if (location.startsWith('/admin/library')) return 'library';
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

    return null;
  };

  return (
    <div className="min-h-screen bg-background">
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
