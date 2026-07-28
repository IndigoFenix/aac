// src/components/layout/MainLayout.tsx
// Responsive layout with mobile chat modes and resizable desktop panels

import { useRef, useState, useCallback, useEffect } from 'react';
import { ChatFeature } from '@/features/ChatFeature';
import { ChatPopup } from '@/features/ChatPopup';
import { SyntAACxPanel } from '@/features/SyntAACxPanel';
import { CustomAppPanel } from '@/features/CustomAppPanel';
import { CommuniAACtePanel } from '@/features/CommuniAACtePanel';
import { DocuSLPPanel } from '@/features/DocuSLPPanel';
import { useFeaturePanel } from '@/contexts/FeaturePanelContext';
import { useLanguage } from '@/contexts/LanguageContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useStudent } from '@/hooks/useStudent';
import { useInstitute } from '@/hooks/useInstitute';
import { useClinicianActivityTracker } from '@/hooks/useClinicianActivityTracker';
import { cn } from '@/lib/utils';
import { OverviewPanel } from '@/features/OverviewPanel';
import { StudentsPanel } from '@/features/StudentsPanel';
import { StudentInfoPanel } from '@/features/StudentInfoPanel';
import { StudentContactsPanel } from '@/features/StudentContactsPanel';
import { StudentProgressPanel } from '@/features/StudentProgressPanel';
import { InstitutePanel } from '@/features/InstitutePanel';
import { ReportsPanel } from '@/features/ReportsPanel';
import { SettingsPanel } from '@/features/SettingsPanel';
import { AACSettingsPanel } from '@/features/AACSettingsPanel';
import { VideoCaptionPanel } from '@/features/VideoCaptionPanel';
import { SymbolsPanel } from '@/features/SymbolsPanel';
import { CalendarPanel } from '@/features/CalendarPanel';
import { LocationsPanel } from '@/features/LocationsPanel';
import { PersonChatPanel } from '@/features/personChat/PersonChatPanel';
import { CallPanel } from '@/features/call/CallPanel';
import { DeepAnalysisPanel } from '@/features/DeepAnalysisPanel';
import { SharesPanel } from '@/features/SharesPanel';
import { InsuranceBridgePanel } from '@/features/InsuranceBridgePanel';
import { DownloadsPanel } from '@/features/DownloadsPanel';
import { Button } from '@/components/ui/button';
import { MessageCircle, Maximize2, Minimize2, X } from 'lucide-react';

/** Minimum width (px) for the chat section AND the panel. The resize clamp and
 *  the chat section's min-width are kept in sync via this single constant — if
 *  they drift, the chat's min-width can exceed its flex % and push the panel
 *  off-screen (and desync the drag handle from the border). */
const CHAT_MIN_PX = 300;

export function MainLayout() {
  const {
    activeFeature,
    panels,
    transitionDuration,
    chatMode,
    chatSize,
    setChatSize,
    isFullScreenFeature,
    mobileChatMode,
    setMobileChatMode,
  } = useFeaturePanel();

  const { isRTL, t } = useLanguage();
  const isMobile = useIsMobile();
  const { student } = useStudent();
  const { currentInstitute, currentPermissions } = useInstitute();

  // Insurance Bridge — clinician activity tracker. Only mounts when the
  // institute has the module enabled, to avoid heartbeat traffic for
  // licenses that won't use it.
  useClinicianActivityTracker({
    enabled: !!currentPermissions?.insuranceBridgeEnabled,
    studentId: student?.id ?? null,
    instituteId: currentInstitute?.id ?? null,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  // Get panel state
  const currentPanel = activeFeature ? panels[activeFeature] : null;
  const isPanelOpen = currentPanel?.isOpen || false;

  // Determine if chat should be shown inline or as popup (desktop only)
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
      percentage = ((rect.right - e.clientX) / rect.width) * 100;
    } else {
      percentage = ((e.clientX - rect.left) / rect.width) * 100;
    }

    // The chat section has a hard min-width (CHAT_MIN_PX, matching its
    // `min-w-[...]`), and the panel is flex-shrink-0. If the dragged percentage
    // resolves to fewer than CHAT_MIN_PX, the chat's min-width overrides its
    // flex %, the panel keeps its (100 - chatSize)% and the two sum past 100%
    // — the panel spills off-screen and the absolutely-positioned handle (drawn
    // at chatSize%) desyncs from the real border. Clamp so the chat (and,
    // symmetrically, the panel) never drop below CHAT_MIN_PX. Direction-agnostic.
    if (rect.width > CHAT_MIN_PX * 2) {
      const minPct = (CHAT_MIN_PX / rect.width) * 100;
      percentage = Math.min(Math.max(percentage, minPct), 100 - minPct);
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
      case 'customApps':
        return <CustomAppPanel isOpen={isPanelOpen} />;
      case 'interpret':
        return <CommuniAACtePanel isOpen={isPanelOpen} />;
      case 'docuslp':
        return <DocuSLPPanel isOpen={isPanelOpen} />;
      case 'overview':
        return <OverviewPanel isOpen={isPanelOpen} />;
      case 'institute':
        return <InstitutePanel isOpen={isPanelOpen} />;
      case 'students':
        return <StudentsPanel isOpen={isPanelOpen} />;
      case 'studentInfo':
        return <StudentInfoPanel isOpen={isPanelOpen} />;
      case 'contacts':
        return <StudentContactsPanel isOpen={isPanelOpen} />;
      case 'progress':
        return <StudentProgressPanel isOpen={isPanelOpen} />;
      case 'reports':
        return <ReportsPanel isOpen={isPanelOpen} />;
      case 'settings':
        return <SettingsPanel />;
      case 'aacsettings':
        return <AACSettingsPanel isOpen={isPanelOpen} />;
      case 'symbols':
        return <SymbolsPanel isOpen={isPanelOpen} />;
      case 'calendar':
        return <CalendarPanel isOpen={isPanelOpen} />;
      case 'locations':
        return <LocationsPanel isOpen={isPanelOpen} />;
      case 'userchat':
        return <PersonChatPanel isOpen={isPanelOpen} />;
      case 'call':
        return <CallPanel isOpen={isPanelOpen} />;
      case 'deepAnalysis':
        return <DeepAnalysisPanel isOpen={isPanelOpen} />;
      case 'shares':
        return <SharesPanel isOpen={isPanelOpen} />;
      case 'insuranceBridge':
        return <InsuranceBridgePanel isOpen={isPanelOpen} />;
      case 'videoCaption':
        return <VideoCaptionPanel isOpen={isPanelOpen} />;
      case 'downloads':
        return <DownloadsPanel isOpen={isPanelOpen} />;
      default:
        return null;
    }
  };

  // ─── MOBILE LAYOUT ──────────────────────────────────────────────────────────
  if (isMobile) {
    const isOnChatPage = !activeFeature || activeFeature === 'chat';

    // Chat page: full-screen chat
    if (isOnChatPage) {
      return (
        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          <ChatFeature />
        </div>
      );
    }

    // Panel page with mobile chat modes
    return (
      <div className="flex-1 flex flex-col min-h-0 relative overflow-hidden">
        {mobileChatMode === 'full' ? (
          // Full-screen chat overlay
          <div className="flex-1 flex flex-col min-h-0">
            <MobileChatHeader
              mode="full"
              onClose={() => setMobileChatMode('hidden')}
              onToggle={() => setMobileChatMode('half')}
            />
            <div className="flex-1 min-h-0 overflow-hidden">
              <ChatFeature />
            </div>
          </div>
        ) : mobileChatMode === 'half' ? (
          // Half layout: panel top, chat bottom
          <>
            <div className="h-1/2 overflow-auto flex-shrink-0">
              {renderFeaturePanel()}
            </div>
            <div className="h-1/2 flex flex-col border-t border-border flex-shrink-0">
              <MobileChatHeader
                mode="half"
                onClose={() => setMobileChatMode('hidden')}
                onToggle={() => setMobileChatMode('full')}
              />
              <div className="flex-1 min-h-0 overflow-hidden">
                <ChatFeature />
              </div>
            </div>
          </>
        ) : (
          // Panel full-screen with floating chat FAB
          <>
            <div className="flex-1 overflow-auto">
              {renderFeaturePanel()}
            </div>
            <button type="button"
              className={cn(
                "fixed z-30 bottom-4 h-14 w-14 rounded-full shadow-lg",
                "bg-primary hover:bg-primary/90 text-primary-foreground",
                "flex items-center justify-center",
                "transition-transform hover:scale-105 active:scale-95",
                isRTL ? "left-4" : "right-4"
              )}
              onClick={() => setMobileChatMode('half')}
              aria-label={t('chat.openChat')}
            >
              <MessageCircle className="w-6 h-6" />
            </button>
          </>
        )}
      </div>
    );
  }

  // ─── DESKTOP LAYOUT ─────────────────────────────────────────────────────────

  // Resize handle component
  const ResizeHandle = showChatInline && isPanelOpen && (
    // Pointer-only resize handle. The functionality is fine-pointer drag,
    // which WCAG 2.1.1 exempts from the keyboard-equivalent rule. The actual
    // panel content is reachable via keyboard regardless of position.
     
    <div
      role="separator"
      aria-orientation="vertical"
      aria-hidden="true"
      className={cn(
        "absolute top-0 bottom-0 w-1 cursor-col-resize z-20 group",
        "hover:bg-primary/30 active:bg-primary/50",
        "transition-colors duration-150",
        isResizing && "bg-primary/50"
      )}
      style={{
        ...(isRTL
          ? { right: `${chatSize}%`, transform: 'translateX(50%)' }
          : { left: `${chatSize}%`, transform: 'translateX(-50%)' }),
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
      className="h-full flex flex-col"
      style={{
        minWidth: CHAT_MIN_PX,
        width: getChatWidth(),
        transition: isResizing ? 'none' : `width ${transitionDuration}ms ease-in-out`,
      }}
    >
      {/* Chat area */}
      <div className="flex-1 min-h-0 overflow-hidden">
        <ChatFeature />
      </div>
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

      {/* Chat popup overlay (desktop only) */}
      {showChatPopup && <ChatPopup />}
    </div>
  );
}

// Mobile chat header bar with mode toggle and close button
function MobileChatHeader({
  mode,
  onClose,
  onToggle,
}: {
  mode: 'full' | 'half';
  onClose: () => void;
  onToggle: () => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30 flex-shrink-0">
      <span className="text-sm font-medium">{t('header.title')}</span>
      <div className="flex gap-1">
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={onToggle}
          aria-label={mode === 'full' ? t('chat.halfScreen') : t('chat.fullScreen')}
        >
          {mode === 'full' ? (
            <Minimize2 className="w-4 h-4" />
          ) : (
            <Maximize2 className="w-4 h-4" />
          )}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          onClick={onClose}
          aria-label={t('chat.closeChat')}
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
