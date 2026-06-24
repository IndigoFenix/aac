// client/src/features/call/InvitePeoplePopup.tsx
//
// A multi-select people picker used for BOTH starting a new group call and
// inviting more people into an active one. Lists callable students (with an
// online dot) and institute contacts; the caller gets back the chosen personIds
// plus whether AAC invitees should open the call automatically (vs ring).

import { useEffect, useMemo, useState } from "react";
import { Loader2, Search, X } from "lucide-react";
import { useInstitute } from "@/hooks/useInstitute";
import { useLanguage } from "@/contexts/LanguageContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { fetchContacts, type PersonChatContact } from "@/features/personChat/api";
import { fetchCallableStudents, type CallableStudent } from "./api";

interface Person {
  personId: string;
  name: string;
  sub?: string;
  online?: boolean;
  isStudent: boolean;
}

function contactName(c: PersonChatContact): string {
  const full = [c.firstName, c.lastName].filter(Boolean).join(" ").trim();
  return full || c.email;
}

interface Props {
  title: string;
  confirmLabel: string;
  /** Already in the call — hidden from the list. */
  excludePersonIds?: string[];
  onConfirm: (personIds: string[], autoAccept: boolean) => void;
  onClose: () => void;
}

export function InvitePeoplePopup({ title, confirmLabel, excludePersonIds, onConfirm, onClose }: Props) {
  const { t } = useLanguage();
  const { currentInstitute, institutes } = useInstitute();
  const instituteId = currentInstitute?.id ?? institutes[0]?.id ?? null;

  const [students, setStudents] = useState<CallableStudent[]>([]);
  const [contacts, setContacts] = useState<PersonChatContact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [autoAccept, setAutoAccept] = useState(false);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    Promise.all([
      fetchCallableStudents().catch(() => []),
      instituteId ? fetchContacts(instituteId).catch(() => []) : Promise.resolve([]),
    ]).then(([s, c]) => {
      if (!alive) return;
      setStudents(s);
      setContacts(c);
      setLoading(false);
    });
    return () => { alive = false; };
  }, [instituteId]);

  const excluded = useMemo(() => new Set(excludePersonIds ?? []), [excludePersonIds]);

  const people = useMemo<Person[]>(() => {
    const out: Person[] = [];
    const seen = new Set<string>(excluded);
    for (const s of students) {
      if (seen.has(s.personId)) continue;
      seen.add(s.personId);
      out.push({ personId: s.personId, name: s.name, online: s.online, isStudent: true });
    }
    for (const c of contacts) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      out.push({ personId: c.id, name: contactName(c), sub: c.email, isStudent: false });
    }
    const q = search.trim().toLowerCase();
    return q ? out.filter((p) => `${p.name} ${p.sub ?? ""}`.toLowerCase().includes(q)) : out;
  }, [students, contacts, search, excluded]);

  const toggle = (personId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(personId) ? next.delete(personId) : next.add(personId);
      return next;
    });

  const confirm = () => {
    if (selected.size === 0) return;
    onConfirm([...selected], autoAccept);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[80vh] w-full max-w-md flex-col rounded-xl border border-border bg-background shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border p-3">
          <span className="font-semibold">{title}</span>
          <Button type="button" size="icon" variant="ghost" onClick={onClose} aria-label={t("common.close")}>
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="border-b border-border p-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="ps-8"
              placeholder={t("call.searchPeople")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              aria-label={t("call.searchPeople")}
            />
          </div>
        </div>

        <ScrollArea className="flex-1">
          {loading ? (
            <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> {t("call.loadingContacts")}
            </div>
          ) : people.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">{t("call.noPeople")}</div>
          ) : (
            people.map((p) => {
              const isSel = selected.has(p.personId);
              return (
                <button
                  key={p.personId}
                  type="button"
                  onClick={() => toggle(p.personId)}
                  aria-pressed={isSel}
                  className={`flex w-full items-center gap-3 border-b border-border px-3 py-2 text-start hover:bg-muted ${isSel ? "bg-primary/10" : ""}`}
                >
                  <span className={`flex h-5 w-5 shrink-0 items-center justify-center rounded border ${isSel ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"}`}>
                    {isSel && <span className="text-xs leading-none">✓</span>}
                  </span>
                  {p.isStudent && (
                    <span className={`h-2 w-2 shrink-0 rounded-full ${p.online ? "bg-green-500" : "bg-muted-foreground/40"}`} aria-hidden="true" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{p.name}</span>
                    {p.sub && <span className="block truncate text-xs text-muted-foreground">{p.sub}</span>}
                  </span>
                </button>
              );
            })
          )}
        </ScrollArea>

        <div className="space-y-3 border-t border-border p-3">
          <label className="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" className="mt-0.5" checked={autoAccept} onChange={(e) => setAutoAccept(e.target.checked)} />
            <span>
              <span className="font-medium">{t("call.automatic")}</span>
              <span className="block text-xs text-muted-foreground">{t("call.automaticHint")}</span>
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
            <Button type="button" disabled={selected.size === 0} onClick={confirm}>
              {confirmLabel}{selected.size > 0 ? ` (${selected.size})` : ""}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
