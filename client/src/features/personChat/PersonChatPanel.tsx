import { useEffect, useMemo, useRef, useState } from "react";
import { useInstitute } from "@/hooks/useInstitute";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { MessagesSquare, Plus, Users as UsersIcon, Send, Loader2, AlertCircle, Check } from "lucide-react";
import { usePersonChat, type ClientPersonChatMessage } from "./PersonChatContext";
import { fetchContacts, type PersonChatContact, type PersonChatRoomListEntry } from "./api";

interface PersonChatPanelProps {
  isOpen?: boolean;
}

function displayNameFor(p: { firstName: string | null; lastName: string | null; email: string }): string {
  const full = [p.firstName, p.lastName].filter(Boolean).join(" ").trim();
  return full || p.email;
}

function roomTitle(entry: PersonChatRoomListEntry, selfPersonId: string | null): string {
  if (entry.room.name) return entry.room.name;
  const others = entry.participants.filter((p) => p.personId !== selfPersonId);
  if (others.length === 0) return entry.participants.map(displayNameFor).join(", ");
  return others.map(displayNameFor).join(", ");
}

function formatTime(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString();
}

export function PersonChatPanel({ isOpen }: PersonChatPanelProps) {
  const { t, isRTL } = useLanguage();
  const { institutes, currentInstitute } = useInstitute();
  const {
    rooms,
    selfPersonId,
    activeRoomId,
    messagesByRoom,
    hasMoreByRoom,
    loadingMoreByRoom,
    refreshRooms,
    openRoom,
    loadOlder,
    send,
    createDirect,
    createGroup,
  } = usePersonChat();

  const [newChatOpen, setNewChatOpen] = useState(false);

  useEffect(() => {
    if (isOpen) refreshRooms();
  }, [isOpen, refreshRooms]);

  const activeEntry = useMemo(
    () => rooms.find((r) => r.room.id === activeRoomId) ?? null,
    [rooms, activeRoomId],
  );

  return (
    <div className="flex h-full w-full min-h-0 bg-background">
      {/* Room list */}
      <div className="w-72 border-r border-border flex flex-col min-h-0">
        <div className="p-3 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <MessagesSquare className="w-4 h-4" />
            <span className="font-semibold">{t("personChat.title")}</span>
          </div>
          <Button size="sm" variant="outline" onClick={() => setNewChatOpen(true)} data-testid="person-chat-new">
            <Plus className="w-4 h-4 mr-1" /> {t("personChat.newChat")}
          </Button>
        </div>
        <ScrollArea dir={isRTL ? 'rtl' : 'ltr'} className="flex-1">
          {rooms.length === 0 && (
            <div className="p-4 text-sm text-muted-foreground">{t("personChat.noRooms")}</div>
          )}
          {rooms.map((entry) => (
            <button type="button"
              key={entry.room.id}
              onClick={() => openRoom(entry.room.id)}
              className={cn(
                "w-full text-start px-3 py-2 border-b border-border hover:bg-muted transition-colors",
                activeRoomId === entry.room.id && "bg-muted",
              )}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium truncate">{roomTitle(entry, selfPersonId)}</span>
                {entry.unreadCount > 0 && (
                  <span className="ml-2 text-xs px-2 py-0.5 bg-primary text-primary-foreground rounded-full">
                    {entry.unreadCount}
                  </span>
                )}
              </div>
              {entry.lastMessage && (
                <div className="text-xs text-muted-foreground truncate mt-1">
                  {entry.lastMessage.body}
                </div>
              )}
            </button>
          ))}
        </ScrollArea>
      </div>

      {/* Active room */}
      <div className="flex-1 flex flex-col min-h-0">
        {activeEntry ? (
          <RoomView
            entry={activeEntry}
            selfPersonId={selfPersonId}
            messages={messagesByRoom[activeEntry.room.id] ?? []}
            hasMore={hasMoreByRoom[activeEntry.room.id] ?? false}
            loadingMore={!!loadingMoreByRoom[activeEntry.room.id]}
            onLoadOlder={() => loadOlder(activeEntry.room.id)}
            onSend={(body) => send(activeEntry.room.id, body)}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-muted-foreground">
            {t("personChat.selectRoomHint")}
          </div>
        )}
      </div>

      <NewChatDialog
        open={newChatOpen}
        onClose={() => setNewChatOpen(false)}
        currentInstituteId={currentInstitute?.id ?? institutes[0]?.id ?? null}
        onCreateDirect={async (instituteId, otherPersonId) => {
          const id = await createDirect(instituteId, otherPersonId);
          await openRoom(id);
        }}
        onCreateGroup={async (instituteId, participantIds, name) => {
          const id = await createGroup(instituteId, participantIds, name);
          await openRoom(id);
        }}
      />
    </div>
  );
}

function RoomView(props: {
  entry: PersonChatRoomListEntry;
  selfPersonId: string | null;
  messages: ClientPersonChatMessage[];
  hasMore: boolean;
  loadingMore: boolean;
  onLoadOlder: () => void;
  onSend: (body: string) => Promise<void>;
}) {
  const { t } = useLanguage();
  const { entry, selfPersonId, messages, hasMore, loadingMore, onLoadOlder, onSend } = props;
  const [draft, setDraft] = useState("");
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const lastLengthRef = useRef(messages.length);

  const participantsById = useMemo(() => {
    const map = new Map<string, string>();
    for (const p of entry.participants) map.set(p.personId, displayNameFor(p));
    return map;
  }, [entry.participants]);

  // Scroll to bottom when a new message arrives (not on history prepend).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grew = messages.length > lastLengthRef.current;
    lastLengthRef.current = messages.length;
    if (grew) {
      // If the most recent message is appended (sent or received), stick to bottom.
      el.scrollTop = el.scrollHeight;
    }
  }, [messages]);

  // Intersection observer on the "load older" sentinel.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel || !hasMore) return;
    const obs = new IntersectionObserver((entries) => {
      for (const e of entries) {
        if (e.isIntersecting && !loadingMore) onLoadOlder();
      }
    });
    obs.observe(sentinel);
    return () => obs.disconnect();
  }, [hasMore, loadingMore, onLoadOlder]);

  const handleSend = async () => {
    const body = draft.trim();
    if (!body) return;
    setDraft("");
    try {
      await onSend(body);
    } catch (err) {
      console.error(err);
    }
  };

  return (
    <div className="flex flex-col h-full min-h-0">
      <div className="px-4 py-3 border-b border-border">
        <div className="font-semibold">{entry.room.name || entry.participants.filter((p) => p.personId !== selfPersonId).map(displayNameFor).join(", ")}</div>
        <div className="text-xs text-muted-foreground flex items-center gap-1">
          <UsersIcon className="w-3 h-3" /> {entry.participants.length} {t("personChat.participants")}
        </div>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-2">
        {hasMore && (
          <div ref={sentinelRef} className="text-center text-xs text-muted-foreground py-2">
            {loadingMore ? t("personChat.loadingOlder") : t("personChat.scrollForOlder")}
          </div>
        )}
        {messages.map((m) => {
          const isMe = m.senderPersonId === selfPersonId;
          return (
            <div key={m.id} className={cn("flex", isMe ? "justify-end" : "justify-start")}>
              <div className={cn(
                "max-w-[70%] rounded-lg px-3 py-2",
                isMe ? "bg-primary text-primary-foreground" : "bg-muted",
                m.status === "sending" && "opacity-70",
                m.status === "failed" && "ring-1 ring-destructive",
              )}>
                {!isMe && (
                  <div className="text-xs font-medium mb-0.5">
                    {participantsById.get(m.senderPersonId) ?? t("personChat.unknownUser")}
                  </div>
                )}
                <div className="whitespace-pre-wrap break-words">{m.body}</div>
                <div className={cn("text-[10px] mt-1 opacity-70 flex items-center gap-1", isMe ? "justify-end" : "")}>
                  <span>{formatTime(m.createdAt)}</span>
                  {isMe && m.status === "sending" && (
                    <Loader2 className="w-3 h-3 animate-spin" aria-label={t("personChat.statusSending")} />
                  )}
                  {isMe && m.status === "sent" && (
                    <Check className="w-3 h-3" aria-label={t("personChat.statusSent")} />
                  )}
                  {isMe && m.status === "failed" && (
                    <AlertCircle className="w-3 h-3 text-destructive" aria-label={t("personChat.statusFailed")} />
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="border-t border-border p-3 flex gap-2">
        <Input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              handleSend();
            }
          }}
          placeholder={t("personChat.composerPlaceholder")}
          data-testid="person-chat-composer"
        />
        <Button onClick={handleSend} disabled={!draft.trim()} data-testid="person-chat-send" aria-label={t('personChat.send') || 'Send'}>
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}

function NewChatDialog(props: {
  open: boolean;
  onClose: () => void;
  currentInstituteId: string | null;
  onCreateDirect: (instituteId: string, otherPersonId: string) => Promise<void>;
  onCreateGroup: (instituteId: string, participantIds: string[], name: string) => Promise<void>;
}) {
  const { t, isRTL } = useLanguage();
  const { open, onClose, currentInstituteId, onCreateDirect, onCreateGroup } = props;
  const [contacts, setContacts] = useState<PersonChatContact[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [name, setName] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setName("");
    setSearch("");
    if (currentInstituteId) {
      fetchContacts(currentInstituteId).then(setContacts).catch((err) => {
        console.error("[personChat] fetchContacts:", err);
        setContacts([]);
      });
    } else {
      setContacts([]);
    }
  }, [open, currentInstituteId]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) => {
      const label = `${c.firstName ?? ""} ${c.lastName ?? ""} ${c.email}`.toLowerCase();
      return label.includes(q);
    });
  }, [contacts, search]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const canSubmit = !!currentInstituteId && selected.size >= 1 && (selected.size === 1 || name.trim().length > 0);

  const submit = async () => {
    if (!currentInstituteId || submitting || !canSubmit) return;
    setSubmitting(true);
    try {
      const ids = Array.from(selected);
      if (ids.length === 1) {
        await onCreateDirect(currentInstituteId, ids[0]);
      } else {
        await onCreateGroup(currentInstituteId, ids, name.trim());
      }
      onClose();
    } catch (err) {
      console.error("[personChat] create room:", err);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(v) => { if (!v) onClose(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("personChat.newChat")}</DialogTitle>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {!currentInstituteId && (
            <div className="text-sm text-muted-foreground">{t("personChat.noInstitute")}</div>
          )}
          {currentInstituteId && (
            <>
              <Input
                placeholder={t("personChat.searchContacts")}
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              <ScrollArea dir={isRTL ? 'rtl' : 'ltr'} className="h-64 border rounded-md">
                {filtered.length === 0 && (
                  <div className="p-3 text-sm text-muted-foreground">{t("personChat.noContacts")}</div>
                )}
                {filtered.map((c) => {
                  const cbId = `person-chat-contact-${c.id}`;
                  const labelId = `${cbId}-label`;
                  return (
                    <div
                      key={c.id}
                      className="flex items-center gap-3 px-3 py-2 border-b last:border-b-0 hover:bg-muted"
                    >
                      <Checkbox
                        id={cbId}
                        aria-labelledby={labelId}
                        checked={selected.has(c.id)}
                        onCheckedChange={() => toggle(c.id)}
                      />
                      <label
                        id={labelId}
                        htmlFor={cbId}
                        className="cursor-pointer flex-1"
                      >
                        <div className="font-medium">{displayNameFor(c)}</div>
                        <div className="text-xs text-muted-foreground">{c.email}</div>
                      </label>
                    </div>
                  );
                })}
              </ScrollArea>
              {selected.size > 1 && (
                <div>
                  <Label htmlFor="person-chat-group-name">{t("personChat.groupName")}</Label>
                  <Input
                    id="person-chat-group-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={t("personChat.groupNamePlaceholder")}
                  />
                </div>
              )}
            </>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>{t("common.cancel")}</Button>
          <Button disabled={!canSubmit || submitting} onClick={submit}>
            {t("personChat.create")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
