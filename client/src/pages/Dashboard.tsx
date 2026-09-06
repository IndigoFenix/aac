// src/pages/Dashboard.tsx
import { useState, useEffect } from 'react';
import { Sidebar } from '@/components/layout/Sidebar';
import { TopHeader } from '@/components/layout/TopHeader';
import { MainLayout } from '@/components/layout/MainLayout';
import { GlobalAuthModals } from '@/components/GlobalAuthModals';
import { LicensePaywallBanner } from '@/components/billing/LicensePaywallBanner';
import { useLanguage } from '@/contexts/LanguageContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { cn } from '@/lib/utils';

export default function Dashboard() {
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [isMobileSidebarOpen, setIsMobileSidebarOpen] = useState(false);
  const { isRTL, direction } = useLanguage();
  const isMobile = useIsMobile();

  // Responsive sidebar collapse (desktop only)
  useEffect(() => {
    if (!isMobile && window.innerWidth < 1024) {
      setIsSidebarCollapsed(true);
    }
  }, [isMobile]);

  // Close mobile sidebar when resizing to desktop
  useEffect(() => {
    if (!isMobile) setIsMobileSidebarOpen(false);
  }, [isMobile]);

  const mainMargin = isMobile
    ? ''
    : isSidebarCollapsed
      ? (isRTL ? 'mr-20' : 'ml-20')
      : (isRTL ? 'mr-80' : 'ml-80');

  const handleToggleSidebar = () => {
    if (isMobile) {
      setIsMobileSidebarOpen(prev => !prev);
    } else {
      setIsSidebarCollapsed(prev => !prev);
    }
  };

  return (
    <div
      className={cn(
        "flex h-screen bg-background overflow-hidden",
        isRTL && "flex-row-reverse"
      )}
      dir={direction}
    >
      {/* Mobile sidebar drawer */}
      {isMobile && (
        <>
          {/* Backdrop — click-outside-to-close. Esc-to-close is handled by
              the sidebar modal itself; this is a pointer convenience. */}
          { }
          <div
            aria-hidden="true"
            className={cn(
              "fixed inset-0 bg-black/50 z-40 transition-opacity duration-300",
              isMobileSidebarOpen ? "opacity-100" : "opacity-0 pointer-events-none"
            )}
            onClick={() => setIsMobileSidebarOpen(false)}
          />
          {/* Sidebar drawer */}
          <div
            className={cn(
              "fixed top-0 bottom-0 z-50 transition-transform duration-300 ease-in-out",
              isRTL ? "right-0" : "left-0",
              isMobileSidebarOpen
                ? "translate-x-0"
                : (isRTL ? "translate-x-full" : "-translate-x-full")
            )}
          >
            <Sidebar
              isCollapsed={false}
              position={isRTL ? 'right' : 'left'}
              isMobile
              onNavigate={() => setIsMobileSidebarOpen(false)}
            />
          </div>
        </>
      )}

      {/* Desktop sidebar */}
      {!isMobile && (
        <Sidebar
          isCollapsed={isSidebarCollapsed}
          position={isRTL ? 'right' : 'left'}
        />
      )}

      {/* Main content area */}
      <div
        className={cn(
          "flex-1 min-w-0 min-h-0 flex flex-col transition-all duration-300",
          mainMargin
        )}
      >
        <TopHeader onToggleSidebar={handleToggleSidebar} />
        {/* Renders nothing unless the license is expired or a trial is nearly
            up; never blocks the UI (the server owns entitlement). */}
        <LicensePaywallBanner />
        <MainLayout />
        <GlobalAuthModals />
      </div>
    </div>
  );
}
