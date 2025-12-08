// src/components/layout/MainLayout.tsx
import { useRef } from 'react';
import { ChatFeature } from '@/features/ChatFeature';
import { SyntAACxPanel } from '@/features/SyntAACxPanel';
import { CommuniAACtePanel } from '@/features/CommuniAACtePanel';
import { DocuSLPPanel } from '@/features/DocuSLPPanel';
import { BoardSelector } from '@/components/syntAACx/BoardSelector';
import { useFeaturePanel, FEATURE_CONFIG } from '@/contexts/FeaturePanelContext';
import { cn } from '@/lib/utils';

export function MainLayout() {
  const { 
    activeFeature, 
    panels, 
    getFeatureConfig,
    transitionDuration 
  } = useFeaturePanel();
  
  const containerRef = useRef<HTMLDivElement>(null);

  // Get current feature config
  const featureConfig = activeFeature ? getFeatureConfig(activeFeature) : null;
  
  // Get panel state
  const currentPanel = activeFeature ? panels[activeFeature] : null;
  const isPanelOpen = currentPanel?.isOpen || false;
  const panelSize = currentPanel?.size || (featureConfig?.defaultSize || 0);
  
  // Panel slides in from the 'end' direction (right in LTR, left in RTL via CSS)
  const getPanelTransform = () => {
    if (!isPanelOpen) {
      // In LTR: slides out to right (100%)
      // In RTL: CSS will flip the direction, so we still use 100%
      return 'translateX(100%)';
    }
    return 'translateX(0)';
  };

  const renderFeaturePanel = () => {
    if (!activeFeature) return null;

    switch (activeFeature) {
      case 'boards':
        return <SyntAACxPanel isOpen={isPanelOpen} />;
      case 'interpret':
        return <CommuniAACtePanel isOpen={isPanelOpen} />;
      case 'docuslp':
        return <DocuSLPPanel isOpen={isPanelOpen} />;
      default:
        return null;
    }
  };

  // Check if we should show a bottom bar below chat
  const showBottomBar = featureConfig?.hasBottomBar && isPanelOpen;

  // Panel component - border on start side (left in LTR, right in RTL)
  const Panel = activeFeature ? (
    <div
      className="h-full border-border overflow-hidden flex-shrink-0 border-s"
      style={{
        width: isPanelOpen ? `${panelSize}%` : '0%',
        transform: getPanelTransform(),
        opacity: isPanelOpen ? 1 : 0,
        transition: `width ${transitionDuration}ms ease-in-out, transform ${transitionDuration}ms ease-in-out, opacity ${transitionDuration}ms ease-in-out`,
      }}
    >
      {renderFeaturePanel()}
    </div>
  ) : null;

  // Chat section with optional bottom bar
  const ChatSection = (
    <div 
      className="h-full flex flex-col min-w-[300px] flex-1"
      style={{ 
        transition: `flex ${transitionDuration}ms ease-in-out`,
      }}
    >
      {/* Chat area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ChatFeature />
      </div>
      
      {/* Bottom bar (e.g., BoardSelector for SyntAACx) */}
      {showBottomBar && (
        <div className={cn(
          "border-t border-border bg-background px-4 py-3 flex-shrink-0",
          "transition-all duration-300"
        )}>
          {activeFeature === 'boards' && <BoardSelector />}
        </div>
      )}
    </div>
  );

  return (
    <div 
      ref={containerRef}
      className="flex-1 flex flex-col min-h-0 relative overflow-hidden"
    >
      {/* Main horizontal layout - CSS handles RTL direction */}
      <div className="flex-1 flex min-h-0">
        {ChatSection}
        {Panel}
      </div>
    </div>
  );
}