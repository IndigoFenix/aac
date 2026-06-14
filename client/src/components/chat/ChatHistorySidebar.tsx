// src/components/chat/ChatHistorySidebar.tsx
//
// "Past conversations" sidebar for the expanded clinician chat. Lists the
// current user's own sessions (scoped to the selected student), and lets them
// start a new chat, resume a past one, rename inline, or delete. Data comes
// from useChatSessions; resume/new are delegated to the parent (useChat).

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Plus,
  MessageSquare,
  Pencil,
  Trash2,
  Check,
  X,
  Loader2,
} from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { cn } from "@/lib/utils";
import {
  useChatSessions,
  useRenameChatSession,
  useDeleteChatSession,
  type ChatSessionListItem,
} from "@/hooks/useChatSessions";

interface ChatHistorySidebarProps {
  studentId?: string | null;
  /** Currently open session, so it can be highlighted. */
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewChat: () => void;
  /** Called after deleting the session that's currently open. */
  onDeletedActive: () => void;
  /** When provided (swap mode), shows a back button that returns to the chat. */
  onBack?: () => void;
  /** Extra classes for the root (e.g. a divider border in pinned mode). */
  className?: string;
}

function useRelativeTime() {
  const { language } = useLanguage();
  return (iso: string): string => {
    const then = new Date(iso).getTime();
    const diffMs = Date.now() - then;
    const mins = Math.round(diffMs / 60000);
    if (mins < 1) return new Intl.RelativeTimeFormat(language, { numeric: "auto" }).format(0, "minute");
    const rtf = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
    if (mins < 60) return rtf.format(-mins, "minute");
    const hours = Math.round(mins / 60);
    if (hours < 24) return rtf.format(-hours, "hour");
    const days = Math.round(hours / 24);
    if (days < 7) return rtf.format(-days, "day");
    return new Date(iso).toLocaleDateString(language, { month: "short", day: "numeric" });
  };
}

export function ChatHistorySidebar({
  studentId,
  activeSessionId,
  onSelectSession,
  onNewChat,
  onDeletedActive,
  onBack,
  className,
}: ChatHistorySidebarProps) {
  const { t } = useLanguage();
  const { data, isLoading } = useChatSessions(studentId);
  const renameMutation = useRenameChatSession(studentId);
  const deleteMutation = useDeleteChatSession(studentId);
  const relativeTime = useRelativeTime();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const sessions = data?.sessions ?? [];

  const displayTitle = (s: ChatSessionListItem): string =>
    s.title || s.firstMessage || t("chat.history.untitled");

  const startRename = (s: ChatSessionListItem) => {
    setConfirmDeleteId(null);
    setEditingId(s.id);
    setEditValue(s.title || s.firstMessage || "");
  };

  const commitRename = (id: string) => {
    const title = editValue.trim();
    if (title) {
      renameMutation.mutate({ id, title });
    }
    setEditingId(null);
  };

  const handleDelete = (id: string) => {
    deleteMutation.mutate(id);
    setConfirmDeleteId(null);
    if (id === activeSessionId) onDeletedActive();
  };

  return (
    <div className={cn("flex flex-col h-full w-full bg-muted/30", className)}>
      {/* Back (swap mode) + New chat */}
      <div className="flex-shrink-0 p-3 border-b border-border flex items-center gap-2">
        {onBack && (
          <Button
            size="icon"
            variant="ghost"
            className="h-9 w-9 flex-shrink-0"
            onClick={onBack}
            aria-label={t("chat.history.hide")}
            data-testid="button-history-back"
          >
            <X className="w-4 h-4" />
          </Button>
        )}
        <Button
          variant="outline"
          className="flex-1 justify-start gap-2"
          onClick={onNewChat}
          data-testid="button-new-chat"
        >
          <Plus className="w-4 h-4" />
          {t("chat.history.newChat")}
        </Button>
      </div>

      {/* List */}
      <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-1">
        {isLoading ? (
          <div className="flex items-center justify-center py-8 text-muted-foreground">
            <Loader2 className="w-5 h-5 animate-spin" />
          </div>
        ) : sessions.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-8 px-2">
            {t("chat.history.empty")}
          </p>
        ) : (
          sessions.map((s) => {
            const isActive = s.id === activeSessionId;
            const isEditing = s.id === editingId;
            return (
              <div
                key={s.id}
                className={cn(
                  "group relative rounded-lg px-2 py-2 text-sm cursor-pointer transition-colors",
                  isActive ? "bg-primary/10 text-foreground" : "hover:bg-muted text-muted-foreground hover:text-foreground"
                )}
                onClick={() => !isEditing && onSelectSession(s.id)}
                data-testid={`session-item-${s.id}`}
              >
                {isEditing ? (
                  <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                    <Input
                      // eslint-disable-next-line jsx-a11y/no-autofocus -- intentional: focus the rename field when the user enters edit mode
                      autoFocus
                      value={editValue}
                      onChange={(e) => setEditValue(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") commitRename(s.id);
                        if (e.key === "Escape") setEditingId(null);
                      }}
                      className="h-7 text-sm"
                      data-testid={`rename-input-${s.id}`}
                    />
                    <Button size="icon" variant="ghost" className="h-7 w-7 flex-shrink-0" onClick={() => commitRename(s.id)} aria-label={t("common.save")}>
                      <Check className="w-3.5 h-3.5" />
                    </Button>
                    <Button size="icon" variant="ghost" className="h-7 w-7 flex-shrink-0" onClick={() => setEditingId(null)} aria-label={t("common.cancel")}>
                      <X className="w-3.5 h-3.5" />
                    </Button>
                  </div>
                ) : (
                  <div className="flex items-start gap-2">
                    <MessageSquare className="w-4 h-4 mt-0.5 flex-shrink-0 opacity-60" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{displayTitle(s)}</div>
                      <div className="text-xs opacity-60">{relativeTime(s.lastUpdate)}</div>
                    </div>

                    {/* Hover actions */}
                    {confirmDeleteId === s.id ? (
                      <div className="flex items-center gap-1 flex-shrink-0" onClick={(e) => e.stopPropagation()}>
                        <Button size="icon" variant="ghost" className="h-6 w-6 text-destructive" onClick={() => handleDelete(s.id)} aria-label={t("chat.history.confirmDelete")}>
                          <Check className="w-3.5 h-3.5" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => setConfirmDeleteId(null)} aria-label={t("common.cancel")}>
                          <X className="w-3.5 h-3.5" />
                        </Button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-0.5 flex-shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
                        <Button size="icon" variant="ghost" className="h-6 w-6" onClick={() => startRename(s)} aria-label={t("chat.history.rename")}>
                          <Pencil className="w-3 h-3" />
                        </Button>
                        <Button size="icon" variant="ghost" className="h-6 w-6 hover:text-destructive" onClick={() => setConfirmDeleteId(s.id)} aria-label={t("chat.history.delete")}>
                          <Trash2 className="w-3 h-3" />
                        </Button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
