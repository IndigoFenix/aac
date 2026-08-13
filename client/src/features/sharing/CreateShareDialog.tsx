// src/features/sharing/CreateShareDialog.tsx
//
// Rich create-share dialog (Phase 2). Replaces the MVP single-UUID input with:
//   - An object picker drawn from the current student's records (programs +
//     medical/functional/educational reports + incidents + deep analyses).
//   - A guardian selector backed by studentContacts.linkedUserId.
//   - An optional standing-share types section with mandatory expiry.
//   - A sensitivity-acknowledgment re-prompt that fires inline when the
//     server returns 422 sensitive_unacknowledged.
//
// See planning-docs/cross-institute-sharing-plan.md.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/hooks/useAuth";
import {
  useCreateShareInvite,
  type ShareInviteBundle,
  type ShareableObjectType,
  type StudentShareInvite,
} from "@/hooks/useSharesApi";
import { useStudentPrograms } from "@/hooks/useProgramApi";
import { useAllReports } from "@/hooks/useReportsApi";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  AlertTriangle,
  Copy,
  FileText,
  Activity,
  GraduationCap,
  Stethoscope,
  Brain,
  ClipboardList,
} from "lucide-react";

// =============================================================================
// Types
// =============================================================================

interface CreateShareDialogProps {
  studentId: string;
  sourceInstituteId: string;
  onClose: () => void;
}

/** A single picker row — uniform shape across object types. */
interface PickerItem {
  type: ShareableObjectType;
  id: string;
  /** Human label (e.g., program name, report type + year). */
  label: string;
  /** Secondary line (e.g., "Draft" or finalized date). */
  meta?: string;
  /** From the underlying record's `is_sensitive` flag where one exists. */
  isSensitive: boolean;
}

/** Standing-share-eligible types per the architecture doc. */
const STANDING_TYPES: ShareableObjectType[] = ["incident", "deep_analysis", "monitor_note"];

const TYPE_ICONS: Partial<Record<ShareableObjectType, typeof FileText>> = {
  program: FileText,
  medical_record: Stethoscope,
  functional_report: Activity,
  educational_report: GraduationCap,
  incident: AlertTriangle,
  deep_analysis: Brain,
  custom_app_assignment: ClipboardList,
  monitor_note: ClipboardList,
};

// =============================================================================
// Component
// =============================================================================

export function CreateShareDialog({
  studentId,
  sourceInstituteId,
  onClose,
}: CreateShareDialogProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { user } = useAuth();
  const create = useCreateShareInvite();

  const [tab, setTab] = useState<"per_object" | "standing">("per_object");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(new Set());
  const [standingTypes, setStandingTypes] = useState<Set<ShareableObjectType>>(new Set());
  const [guardianContactId, setGuardianContactId] = useState("");
  const [permission, setPermission] = useState<"read" | "write">("read");
  const [shareExpiryDays, setShareExpiryDays] = useState("");
  const [standingExpiryDays, setStandingExpiryDays] = useState("365");
  const [message, setMessage] = useState("");
  const [sensitiveAcknowledged, setSensitiveAcknowledged] = useState(false);
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);

  // ── Data sources for the picker
  const items = useShareablePickerItems(studentId);
  const { contacts, isLoading: contactsLoading } = useGuardianContacts(studentId);

  // The picker uses `${type}:${id}` as a stable key.
  const itemByKey = useMemo(() => {
    const map = new Map<string, PickerItem>();
    for (const it of items) map.set(`${it.type}:${it.id}`, it);
    return map;
  }, [items]);

  const selectedItems = useMemo(
    () => Array.from(selectedKeys).map((k) => itemByKey.get(k)).filter(Boolean) as PickerItem[],
    [selectedKeys, itemByKey],
  );

  const sensitiveSelected = selectedItems.filter((i) => i.isSensitive);

  const guardianUserId = useMemo(() => {
    const c = contacts.find((x) => x.id === guardianContactId);
    return c?.linkedUserId ?? "";
  }, [guardianContactId, contacts]);

  const hasObjects = selectedItems.length > 0;
  const hasStanding = standingTypes.size > 0;

  const canSubmit =
    !!studentId &&
    !!sourceInstituteId &&
    !!guardianUserId &&
    (hasObjects || hasStanding) &&
    (!hasStanding || Number(standingExpiryDays) > 0) &&
    (sensitiveSelected.length === 0 || sensitiveAcknowledged) &&
    !create.isPending;

  // ── Submit
  const submit = () => {
    const shareExpiresAt =
      shareExpiryDays && Number(shareExpiryDays) > 0
        ? new Date(Date.now() + Number(shareExpiryDays) * 86400_000).toISOString()
        : null;
    const standingExpiresAt = hasStanding
      ? new Date(Date.now() + Number(standingExpiryDays) * 86400_000).toISOString()
      : null;

    const bundle: ShareInviteBundle = {
      objects: selectedItems.map((i) => ({
        type: i.type,
        id: i.id,
        isSensitive: i.isSensitive,
      })),
      standingTypes: Array.from(standingTypes),
      permission,
      shareExpiresAt,
      standingExpiresAt,
      sensitiveAcknowledged,
    };

    create.mutate(
      {
        studentId,
        sourceInstituteId,
        guardianUserId,
        bundle,
        message: message.trim() || null,
        shareExpiresAt,
      },
      {
        onSuccess: (res) => setGeneratedCode(res.code),
        onError: (err) => {
          // 422 sensitive_unacknowledged surfaces with a hint message; the
          // checkbox is already visible in the dialog, so flip-and-resubmit
          // is one click away. Just show the toast.
          if (/sensitive/i.test(err.message)) {
            toast({
              title: t("shares.errors.create"),
              description: t("shares.create.sensitiveAck"),
              variant: "destructive",
            });
          } else {
            toast({
              title: t("shares.errors.create"),
              description: err.message,
              variant: "destructive",
            });
          }
        },
      },
    );
  };

  // ── Code shown — single-shot dismissable view
  if (generatedCode) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("shares.create.codeReadyTitle")}</DialogTitle>
            <DialogDescription>{t("shares.create.codeReadyDescription")}</DialogDescription>
          </DialogHeader>
          <div className="border rounded p-4 text-center font-mono text-2xl tracking-widest">
            {generatedCode}
          </div>
          <div className="rounded border bg-muted/40 p-3 text-sm space-y-2">
            <div className="font-medium">{t("shares.create.codeNextStepsTitle")}</div>
            <ol className="list-decimal ms-5 space-y-1 text-muted-foreground">
              <li>{t("shares.create.codeStepSend")}</li>
              <li>{t("shares.create.codeStepRedeem")}</li>
              <li>{t("shares.create.codeStepApprove")}</li>
            </ol>
            <div className="text-xs text-muted-foreground pt-1 border-t">
              {t("shares.create.codeTtlNote")}
            </div>
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => {
                navigator.clipboard?.writeText(generatedCode);
                toast({ title: t("shares.create.copied") });
              }}
            >
              <Copy className="h-4 w-4 me-1" />
              {t("shares.actions.copy")}
            </Button>
            <Button onClick={onClose}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  // ── Main create form
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t("shares.create.title")}</DialogTitle>
          <DialogDescription>{t("shares.create.description")}</DialogDescription>
        </DialogHeader>

        <DialogBody>
        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <TabsList>
            <TabsTrigger value="per_object">
              {t("shares.create.perObjectTab")}
              {selectedItems.length > 0 && (
                <Badge variant="secondary" className="ms-2">
                  {selectedItems.length}
                </Badge>
              )}
            </TabsTrigger>
            <TabsTrigger value="standing">
              {t("shares.create.standingTab")}
              {standingTypes.size > 0 && (
                <Badge variant="secondary" className="ms-2">
                  {standingTypes.size}
                </Badge>
              )}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="per_object" className="mt-3">
            <ObjectPicker
              items={items}
              selectedKeys={selectedKeys}
              onToggle={(key) => {
                setSelectedKeys((prev) => {
                  const next = new Set(prev);
                  if (next.has(key)) next.delete(key);
                  else next.add(key);
                  return next;
                });
              }}
            />
          </TabsContent>

          <TabsContent value="standing" className="mt-3">
            <StandingPicker
              selected={standingTypes}
              onToggle={(tp) => {
                setStandingTypes((prev) => {
                  const next = new Set(prev);
                  if (next.has(tp)) next.delete(tp);
                  else next.add(tp);
                  return next;
                });
              }}
            />
          </TabsContent>
        </Tabs>

        {/* ─── Common fields ─── */}
        <div className="space-y-3 pt-2 border-t">
          <div>
            <Label>{t("shares.create.guardianContact")}</Label>
            <Select value={guardianContactId} onValueChange={setGuardianContactId}>
              <SelectTrigger>
                <SelectValue placeholder={t("shares.create.guardianContactPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {contactsLoading ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    {t("common.loading")}
                  </div>
                ) : contacts.length === 0 ? (
                  <div className="p-2 text-sm text-muted-foreground">
                    {t("shares.create.noLinkedContacts")}
                  </div>
                ) : (
                  contacts.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                      {c.relationship && (
                        <span className="text-muted-foreground"> — {c.relationship}</span>
                      )}
                    </SelectItem>
                  ))
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="grid grid-cols-3 gap-2">
            <div>
              <Label>{t("shares.create.permission")}</Label>
              <Select value={permission} onValueChange={(v) => setPermission(v as "read" | "write")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="read">{t("shares.permission.read")}</SelectItem>
                  <SelectItem value="write">{t("shares.permission.write")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="share-exp">{t("shares.create.shareExpiryDays")}</Label>
              <Input
                id="share-exp"
                type="number"
                min={0}
                value={shareExpiryDays}
                onChange={(e) => setShareExpiryDays(e.target.value)}
                placeholder="∞"
              />
            </div>
            {hasStanding && (
              <div>
                <Label htmlFor="standing-exp">{t("shares.create.standingExpiryDays")}</Label>
                <Input
                  id="standing-exp"
                  type="number"
                  min={1}
                  value={standingExpiryDays}
                  onChange={(e) => setStandingExpiryDays(e.target.value)}
                />
              </div>
            )}
          </div>

          <div>
            <Label htmlFor="msg">{t("shares.create.messageLabel")}</Label>
            <Textarea
              id="msg"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              rows={2}
            />
          </div>

          {sensitiveSelected.length > 0 && (
            <div className="border border-destructive/50 bg-destructive/5 rounded p-3 space-y-2">
              <div className="flex items-center gap-2 text-destructive font-medium">
                <AlertTriangle className="h-4 w-4" />
                {t("shares.field.sensitiveCount", { count: sensitiveSelected.length })}
              </div>
              <div className="text-xs text-muted-foreground">
                {sensitiveSelected.map((i) => i.label).join(", ")}
              </div>
              <div className="flex items-center gap-2">
                <Checkbox
                  id="ack"
                  checked={sensitiveAcknowledged}
                  onCheckedChange={(v) => setSensitiveAcknowledged(!!v)}
                />
                <Label htmlFor="ack" className="text-sm font-normal cursor-pointer">
                  {t("shares.create.sensitiveAck")}
                </Label>
              </div>
            </div>
          )}
        </div>
        </DialogBody>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button disabled={!canSubmit} onClick={submit}>
            {t("shares.actions.generate")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// =============================================================================
// Sub-components
// =============================================================================

function ObjectPicker({
  items,
  selectedKeys,
  onToggle,
}: {
  items: PickerItem[];
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
}) {
  const { t } = useLanguage();

  // Group by type for readable rendering.
  const groups = useMemo(() => {
    const map = new Map<ShareableObjectType, PickerItem[]>();
    for (const it of items) {
      const list = map.get(it.type) ?? [];
      list.push(it);
      map.set(it.type, list);
    }
    return map;
  }, [items]);

  if (items.length === 0) {
    return <div className="text-sm text-muted-foreground p-4">{t("shares.create.noItems")}</div>;
  }

  return (
    <ScrollArea className="h-72 border rounded">
      <div className="p-2 space-y-3">
        {Array.from(groups.entries()).map(([type, list]) => {
          const Icon = TYPE_ICONS[type] ?? FileText;
          return (
            <div key={type}>
              <div className="text-xs font-semibold text-muted-foreground uppercase flex items-center gap-1 mb-1">
                <Icon className="h-3 w-3" />
                {t(`shares.objectType.${type}`)}
              </div>
              <div className="space-y-1">
                {list.map((it) => {
                  const key = `${it.type}:${it.id}`;
                  const checked = selectedKeys.has(key);
                  return (
                    <label
                      key={key}
                      className="flex items-start gap-2 p-2 rounded hover:bg-accent cursor-pointer"
                    >
                      <Checkbox
                        checked={checked}
                        onCheckedChange={() => onToggle(key)}
                        className="mt-0.5"
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm flex items-center gap-2">
                          <span className="truncate">{it.label}</span>
                          {it.isSensitive && (
                            <Badge variant="destructive" className="text-xs">
                              {t("shares.bundle.sensitive")}
                            </Badge>
                          )}
                        </div>
                        {it.meta && (
                          <div className="text-xs text-muted-foreground">{it.meta}</div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

function StandingPicker({
  selected,
  onToggle,
}: {
  selected: Set<ShareableObjectType>;
  onToggle: (type: ShareableObjectType) => void;
}) {
  const { t } = useLanguage();
  return (
    <div className="border rounded p-3 space-y-2">
      <p className="text-xs text-muted-foreground">{t("shares.create.standingDescription")}</p>
      {STANDING_TYPES.map((tp) => {
        const Icon = TYPE_ICONS[tp] ?? FileText;
        const checked = selected.has(tp);
        return (
          <label
            key={tp}
            className="flex items-center gap-2 p-2 rounded hover:bg-accent cursor-pointer"
          >
            <Checkbox checked={checked} onCheckedChange={() => onToggle(tp)} />
            <Icon className="h-4 w-4 text-muted-foreground" />
            <span className="text-sm">{t(`shares.objectType.${tp}`)}</span>
          </label>
        );
      })}
    </div>
  );
}

// =============================================================================
// Data hooks
// =============================================================================

interface ContactRow {
  id: string;
  name: string;
  relationship: string | null;
  linkedUserId: string | null;
}

/**
 * Pull the current student's contacts and surface only those linked to a User
 * — anyone in the named-guardian role of a share invite must be a registered
 * user (the invite has a NOT NULL `guardian_user_id` FK).
 */
function useGuardianContacts(studentId: string | undefined): { contacts: ContactRow[]; isLoading: boolean } {
  const { data, isLoading } = useQuery<{ success: boolean; contacts: ContactRow[] }>({
    queryKey: ["/api/biometric/students", studentId, "contacts"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/biometric/students/${studentId}/contacts`);
      return res.json();
    },
    enabled: !!studentId,
  });
  const list = data?.contacts ?? [];
  return { contacts: list.filter((c) => !!c.linkedUserId), isLoading };
}

/** Aggregate the picker rows from the student's existing records. */
function useShareablePickerItems(studentId: string | undefined): PickerItem[] {
  const programs = useStudentPrograms(studentId);
  const reports = useAllReports(studentId);
  const incidents = useQuery<{ incidents: Array<any> }>({
    queryKey: ["/api/students", studentId, "incidents"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/students/${studentId}/incidents`);
      return res.json();
    },
    enabled: !!studentId,
  });
  const deepAnalyses = useQuery<Array<any>>({
    queryKey: ["/api/deep-analysis", studentId],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/deep-analysis?studentId=${studentId}`);
      return res.json();
    },
    enabled: !!studentId,
  });

  return useMemo(() => {
    const out: PickerItem[] = [];

    // useStudentPrograms wraps the array in { programs: [...] } — read through.
    for (const p of programs.data?.programs ?? []) {
      out.push({
        type: "program",
        id: p.id,
        label: (p as any).name ?? p.title ?? p.id,
        meta: p.status,
        isSensitive: false, // programs don't carry the flag; default false
      });
    }

    const reportsData = reports.data;
    for (const r of reportsData?.medicalRecords ?? []) {
      out.push({
        type: "medical_record",
        id: r.id,
        label: r.primaryDiagnosis ?? `Medical record ${shortId(r.id)}`,
        meta: r.status,
        isSensitive: r.isSensitive ?? true,
      });
    }
    for (const r of reportsData?.functionalReports ?? []) {
      out.push({
        type: "functional_report",
        id: r.id,
        label: r.reportType ?? `Functional report ${shortId(r.id)}`,
        meta: r.status,
        isSensitive: (r as any).isSensitive ?? true,
      });
    }
    for (const r of reportsData?.educationalReports ?? []) {
      out.push({
        type: "educational_report",
        id: r.id,
        label: r.reportType ?? `Educational report ${shortId(r.id)}`,
        meta: (r as any).academicYear ?? (r as any).status,
        isSensitive: (r as any).isSensitive ?? true,
      });
    }
    for (const inc of incidents.data?.incidents ?? []) {
      out.push({
        type: "incident",
        id: inc.id,
        label: `${inc.type ?? "incident"} (${inc.severity ?? "?"})`,
        meta: inc.recordedAt ? new Date(inc.recordedAt).toLocaleDateString() : undefined,
        isSensitive: inc.isSensitive ?? true,
      });
    }
    for (const da of (deepAnalyses.data as any[] | undefined) ?? []) {
      out.push({
        type: "deep_analysis",
        id: da.id,
        label: da.title ?? `Deep analysis ${shortId(da.id)}`,
        meta: da.status,
        isSensitive: false,
      });
    }
    return out;
  }, [programs.data, reports.data, incidents.data, deepAnalyses.data]);
}

function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
