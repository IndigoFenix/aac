import { useEffect, useMemo, useState } from "react";
import { Phone, Video, Loader2, Gamepad2 } from "lucide-react";
import { useInstitute } from "@/hooks/useInstitute";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchContacts, type PersonChatContact } from "@/features/personChat/api";
import { fetchCallableStudents, type CallableStudent } from "./api";
import { useCall } from "./CallContext";
import CallGameSurface from "@shared/social-world/CallGameSurface";
import { CallWorldHub } from "@shared/social-world/call-game-net";
import { NPC_DEMO_GAME } from "@shared/social-world/default-game";

interface CallPanelProps {
  isOpen?: boolean;
}

function displayNameFor(c: PersonChatContact): string {
  const full = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return full || c.email;
}

/** Resolve a backend ws:// URL, honoring VITE_API_URL (the clinician dev server
 *  doesn't proxy /ws). Mirrors usePersonChatSocket / CallContext. */
function resolveWsUrl(path: string): string {
  const base = (import.meta.env.VITE_API_URL as string | undefined)?.replace(/\/+$/, "") ?? "";
  if (base) {
    const url = new URL(base);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    url.pathname = path;
    return url.toString();
  }
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${path}`;
}

/** Launcher panel: lists contacts and starts a call when one is picked. */
export function CallPanel({ isOpen }: CallPanelProps) {
  const { t, isRTL } = useLanguage();
  const { currentInstitute, institutes } = useInstitute();
  const { startCallWithContact, startCallToStudent, callState, error } = useCall();

  const instituteId = currentInstitute?.id ?? institutes[0]?.id ?? null;
  const [contacts, setContacts] = useState<PersonChatContact[]>([]);
  const [students, setStudents] = useState<CallableStudent[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");

  useEffect(() => {
    if (!isOpen || !instituteId) {
      if (!instituteId) setContacts([]);
      return;
    }
    setLoading(true);
    fetchContacts(instituteId)
      .then(setContacts)
      .catch((err) => {
        console.error("[call] fetchContacts:", err);
        setContacts([]);
      })
      .finally(() => setLoading(false));
  }, [isOpen, instituteId]);

  // Callable students (those who listed this user as a callable contact) — not
  // institute-scoped, so fetched independently of the contacts list.
  useEffect(() => {
    if (!isOpen) return;
    fetchCallableStudents()
      .then(setStudents)
      .catch((err) => {
        console.error("[call] fetchCallableStudents:", err);
        setStudents([]);
      });
  }, [isOpen]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter((c) =>
      `${c.firstName ?? ""} ${c.lastName ?? ""} ${c.email}`.toLowerCase().includes(q),
    );
  }, [contacts, search]);

  const callBusy = callState !== "idle";

  // Dev/test: open the social-world surface on its own — no call, no peers — so
  // the physics + steering can be exercised without setting up a real video call.
  // Reuses the in-call game surface in single-player mode (selfPersonId=null →
  // the canvas runs solo); the hub/sendWorld are inert without a peer.
  const [gameRoomOpen, setGameRoomOpen] = useState(false);
  const soloHub = useMemo(() => new CallWorldHub(), []);

  return (
    <div className="flex h-full w-full min-h-0 flex-col bg-background">
      <div className="p-3 border-b border-border flex items-center gap-2">
        <Phone className="w-4 h-4" />
        <span className="font-semibold">{t("call.title")}</span>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ms-auto gap-1.5"
          onClick={() => setGameRoomOpen(true)}
          aria-label={t("socialWorld.testGameRoom")}
          data-testid="open-test-game-room"
        >
          <Gamepad2 className="w-4 h-4" />
          <span className="hidden sm:inline">{t("socialWorld.testGameRoom")}</span>
        </Button>
      </div>

      {gameRoomOpen && (
        <div className="fixed inset-0 z-[100] bg-black">
          <CallGameSurface
            game={NPC_DEMO_GAME}
            selfPersonId={null}
            sendWorld={() => {}}
            hub={soloHub}
            npcBrainWsUrl={resolveWsUrl("/ws/social-bot")}
            onExit={() => setGameRoomOpen(false)}
            t={t}
          />
        </div>
      )}

      <div className="p-3 border-b border-border">
        <Input
          placeholder={t("call.searchContacts")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label={t("call.searchContacts")}
        />
      </div>

      {error && (
        <div className="px-3 py-2 text-sm text-destructive">{error.message}</div>
      )}

      <ScrollArea dir={isRTL ? "rtl" : "ltr"} className="flex-1">
        {students.length > 0 && (
          <div>
            <div className="px-3 py-1.5 text-xs font-semibold text-muted-foreground bg-muted/50">
              {t("call.students")}
            </div>
            {students.map((s) => (
              <div
                key={s.contactId}
                className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border hover:bg-muted"
              >
                <div className="min-w-0 flex items-center gap-2">
                  <span
                    className={`w-2 h-2 rounded-full shrink-0 ${s.online ? "bg-green-500" : "bg-muted-foreground/40"}`}
                    aria-hidden="true"
                  />
                  <div className="min-w-0">
                    <div className="font-medium truncate">{s.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {s.online ? t("call.online") : t("call.offline")}
                    </div>
                  </div>
                </div>
                <Button
                  type="button"
                  size="icon"
                  variant="outline"
                  disabled={callBusy || !s.online}
                  onClick={() => { void startCallToStudent(s.contactId, s.name, s.personId); }}
                  aria-label={t("call.callPerson", { name: s.name })}
                  data-testid={`call-student-${s.contactId}`}
                >
                  <Video className="w-4 h-4" />
                </Button>
              </div>
            ))}
          </div>
        )}
        {!instituteId && (
          <div className="p-4 text-sm text-muted-foreground">{t("call.noInstitute")}</div>
        )}
        {instituteId && loading && (
          <div className="p-4 text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
            {t("call.loadingContacts")}
          </div>
        )}
        {instituteId && !loading && filtered.length === 0 && (
          <div className="p-4 text-sm text-muted-foreground">{t("call.noContacts")}</div>
        )}
        {instituteId && !loading && filtered.map((c) => (
          <div
            key={c.id}
            className="flex items-center justify-between gap-3 px-3 py-2 border-b border-border hover:bg-muted"
          >
            <div className="min-w-0">
              <div className="font-medium truncate">{displayNameFor(c)}</div>
              <div className="text-xs text-muted-foreground truncate">{c.email}</div>
            </div>
            <Button
              type="button"
              size="icon"
              variant="outline"
              disabled={callBusy}
              onClick={() => { void startCallWithContact(c); }}
              aria-label={t("call.callPerson", { name: displayNameFor(c) })}
              data-testid={`call-contact-${c.id}`}
            >
              <Video className="w-4 h-4" />
            </Button>
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}
