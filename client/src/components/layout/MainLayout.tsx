// src/components/layout/MainLayout.tsx
// UPDATED VERSION - includes resizable panels and chat popup mode with proper RTL support

import { useRef, useState, useCallback, useEffect } from 'react';
import { ChatFeature } from '@/features/ChatFeature';
import { ChatPopup } from '@/features/ChatPopup';
import { SyntAACxPanel } from '@/features/SyntAACxPanel';
import { CommuniAACtePanel } from '@/features/CommuniAACtePanel';
import { DocuSLPPanel } from '@/features/DocuSLPPanel';
import { BoardSelector } from '@/components/syntAACx/BoardSelector';
import { useFeaturePanel, FEATURE_CONFIG } from '@/contexts/FeaturePanelContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { cn } from '@/lib/utils';
import { OverviewPanel } from '@/features/OverviewPanel';
import { StudentsPanel } from '@/features/StudentsPanel';
import { StudentProgressPanel } from '@/features/StudentProgressPanel';

export function MainLayout() {
  const { 
    activeFeature, 
    panels, 
    getFeatureConfig,
    transitionDuration,
    chatMode,
    chatSize,
    setChatSize,
    isFullScreenFeature,
  } = useFeaturePanel();
  
  const { isRTL } = useLanguage();
  const containerRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  // Get current feature config
  const featureConfig = activeFeature ? getFeatureConfig(activeFeature) : null;
  
  // Get panel state
  const currentPanel = activeFeature ? panels[activeFeature] : null;
  const isPanelOpen = currentPanel?.isOpen || false;
  
  // Determine if chat should be shown inline or as popup
  const showChatInline = chatMode === 'expanded' && !isFullScreenFeature;
  const showChatPopup = chatMode === 'popup' || chatMode === 'minimized' || isFullScreenFeature;
  
  // For full-screen features, panel takes 100%
  // For other features with popup chat, panel takes full width
  // Otherwise, use the resizable split
  const getPanelWidth = () => {
    if (!isPanelOpen) return '0%';
    if (isFullScreenFeature) return '100%';
    if (showChatPopup) return '100%';
    return `${100 - chatSize}%`;
  };

  const getChatWidth = () => {
    if (!showChatInline) return '0%';
    if (!isPanelOpen) return '100%';
    return `${chatSize}%`;
  };

  // Handle resize drag
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
  }, []);

  const handleResizeMove = useCallback((e: MouseEvent) => {
    if (!isResizing || !containerRef.current) return;
    
    const container = containerRef.current;
    const rect = container.getBoundingClientRect();
    
    let percentage: number;
    if (isRTL) {
      // In RTL, calculate from the right
      percentage = ((rect.right - e.clientX) / rect.width) * 100;
    } else {
      // In LTR, calculate from the left
      percentage = ((e.clientX - rect.left) / rect.width) * 100;
    }
    
    setChatSize(percentage);
  }, [isResizing, isRTL, setChatSize]);

  const handleResizeEnd = useCallback(() => {
    setIsResizing(false);
  }, []);

  // Add/remove resize event listeners
  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleResizeMove);
      document.addEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    
    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleResizeMove, handleResizeEnd]);

  const renderFeaturePanel = () => {
    if (!activeFeature) return null;

    switch (activeFeature) {
      case 'boards':
        return <SyntAACxPanel isOpen={isPanelOpen} />;
      case 'interpret':
        return <CommuniAACtePanel isOpen={isPanelOpen} />;
      case 'docuslp':
        return <DocuSLPPanel isOpen={isPanelOpen} />;
      case 'overview':
        return <OverviewPanel isOpen={isPanelOpen} />;
      case 'students':
        return <StudentsPanel isOpen={isPanelOpen} />;
      case 'progress':
        return <StudentProgressPanel isOpen={isPanelOpen} />;
      default:
        return null;
    }
  };

  // Check if we should show a bottom bar below chat
  const showBottomBar = featureConfig?.hasBottomBar && isPanelOpen && showChatInline;

  // Resize handle component
  const ResizeHandle = showChatInline && isPanelOpen && (
    <div
      className={cn(
        "absolute top-0 bottom-0 w-1 cursor-col-resize z-20 group",
        "hover:bg-primary/30 active:bg-primary/50",
        "transition-colors duration-150",
        isResizing && "bg-primary/50"
      )}
      style={{
        left: `${chatSize}%`,
        transform: 'translateX(-50%)',
      }}
      onMouseDown={handleResizeStart}
    >
      {/* Visual indicator */}
      <div className={cn(
        "absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
        "w-1 h-8 rounded-full bg-border",
        "group-hover:bg-primary/60 group-active:bg-primary",
        "transition-colors duration-150"
      )} />
    </div>
  );

  // Chat section (inline mode)
  const ChatSection = showChatInline && (
    <div 
      className="h-full flex flex-col min-w-[300px]"
      style={{ 
        width: getChatWidth(),
        transition: isResizing ? 'none' : `width ${transitionDuration}ms ease-in-out`,
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

  // Panel section
  const PanelSection = activeFeature && activeFeature !== 'chat' && (
    <div
      className={cn(
        "h-full overflow-hidden flex-shrink-0",
        showChatInline && isPanelOpen && (isRTL ? "border-e" : "border-s") + " border-border"
      )}
      style={{
        width: getPanelWidth(),
        transition: isResizing ? 'none' : `width ${transitionDuration}ms ease-in-out`,
      }}
    >
      {renderFeaturePanel()}
    </div>
  );

  return (
    <div 
      ref={containerRef}
      dir={isRTL ? 'rtl' : 'ltr'}
      className="flex-1 flex flex-col min-h-0 relative overflow-hidden"
    >
      {/* Main horizontal layout */}
      <div className="flex-1 flex min-h-0 relative">
        {/* In RTL mode, the order is automatically reversed via dir attribute */}
        {ChatSection}
        {ResizeHandle}
        {PanelSection}
        
        {/* Full-width panel when chat is in popup mode */}
        {showChatPopup && activeFeature && activeFeature !== 'chat' && !showChatInline && (
          <div className="flex-1 h-full overflow-hidden">
            {renderFeaturePanel()}
          </div>
        )}
      </div>
      
      {/* Chat popup overlay */}
      {showChatPopup && <ChatPopup />}
    </div>
  );
}