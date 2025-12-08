// src/pages/Dashboard.tsx
import { useState, useEffect } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopHeader } from '@/components/layout/TopHeader';
import { MainLayout } from '@/components/layout/MainLayout';
import { GlobalAuthModals } from '@/components/GlobalAuthModals';
import { useLanguage } from '@/contexts/LanguageContext';
import { FeaturePanelProvider } from '@/contexts/FeaturePanelContext';
import { cn } from '@/lib/utils';

export default function Dashboard() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const { isRTL, direction } = useLanguage();

  // Responsive sidebar collapse
  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) {
        setIsSidebarCollapsed(true);
      }
    };
    
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const sidebarWidth = isSidebarCollapsed ? 'w-20' : 'w-80';
  const mainMargin = isSidebarCollapsed 
    ? (isRTL ? 'mr-20' : 'ml-20')
    : (isRTL ? 'mr-80' : 'ml-80');

  return (
    <FeaturePanelProvider>
      <div 
        className={cn(
          "flex h-screen bg-background overflow-hidden",
          isRTL && "flex-row-reverse"
        )}
        dir={direction}
      >
        {/* Sidebar - positioned based on direction */}
        <Sidebar 
          isCollapsed={isSidebarCollapsed}
          position={isRTL ? 'right' : 'left'}
        />
        
        {/* Main content area */}
        <div 
          className={cn(
            "flex-1 min-w-0 min-h-0 flex flex-col transition-all duration-300",
            mainMargin
          )}
        >
          <TopHeader 
            onToggleSidebar={() => setIsSidebarCollapsed(!isSidebarCollapsed)} 
          />
          <MainLayout />
          <GlobalAuthModals />
        </div>
      </div>
    </FeaturePanelProvider>
  );
}