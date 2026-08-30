// Security incident register — the operator's console during a breach.
//
// Backs the AKIM information-security appendix §6: a 48-hour notice window and
// a 3-day investigation report. Whoever is on call needs to open an incident,
// see what is overdue, and get a notification out, without a database shell.
//
// Two deliberate frictions:
//   * Sending is always preceded by a preview. The first click renders the
//     counsel-reviewed letter and lists any placeholder still unfilled; only
//     then does a separate, differently-styled button send it.
//   * Overdue obligations are computed server-side and shown as such. The
//     client never re-derives a deadline — one owner for that rule.

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, AlertTriangle, Plus, Send, Eye } from "lucide-react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  useAddIncidentNote,
  useCloseIncident,
  useNotifyIncident,
  useOpenIncident,
  useSecurityIncident,
  useSecurityIncidents,
  useUpdateIncident,
  type IncidentKind,
  type IncidentSeverity,
  type IncidentStatus,
  type NotifyResponse,
  type SecurityIncident,
} from "@/hooks/useSecurityIncidents";

const KINDS: IncidentKind[] = ["phi_breach", "security_breach", "vendor_incident"];
const SEVERITIES: IncidentSeverity[] = ["low", "medium", "high", "critical"];
const STATUSES: IncidentStatus[] = [
  "open",
  "contained",
  "notified",
  "closed",
  "dismissed",
];

function severityVariant(
  s: IncidentSeverity,
): "default" | "secondary" | "destructive" | "outline" {
  if (s === "critical" || s === "high") return "destructive";
  if (s === "medium") return "default";
  return "secondary";
}

function formatDateTime(value: string | null, locale: string): string {
  if (!value) return "—";
  return new Date(value).toLocaleString(locale);
}

/** A deadline cell: the time, plus whether it has been met or blown. */
function DeadlineCell({
  dueAt,
  doneAt,
  overdue,
  locale,
  metLabel,
}: {
  dueAt: string | null;
  doneAt: string | null;
  overdue: boolean;
  locale: string;
  metLabel: string;
}) {
  if (!dueAt) return <span className="text-muted-foreground">—</span>;
  if (doneAt) {
    return (
      <span className="text-muted-foreground">
        {metLabel} {formatDateTime(doneAt, locale)}
      </span>
    );
  }
  return (
    <span className={overdue ? "text-destructive font-semibold" : undefined}>
      {formatDateTime(dueAt, locale)}
    </span>
  );
}

export function SecurityIncidents() {
  const { t, language } = useLanguage();
  const { toast } = useToast();
  const [includeClosed, setIncludeClosed] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [openFormShown, setOpenFormShown] = useState(false);

  const { data, isLoading } = useSecurityIncidents(includeClosed);
  const incidents = data?.incidents ?? [];

  const overdueCount = useMemo(
    () => incidents.filter((i) => i.overdue.length > 0).length,
    [incidents],
  );

  return (
    <div className="space-y-4" data-testid="admin-security-incidents">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-semibold">{t("admin.incidents.title")}</h2>
          <p className="text-sm text-muted-foreground">
            {t("admin.incidents.subtitle")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => setIncludeClosed((v) => !v)}
            data-testid="incidents-toggle-closed"
          >
            {includeClosed
              ? t("admin.incidents.hideClosed")
              : t("admin.incidents.showClosed")}
          </Button>
          <Button onClick={() => setOpenFormShown(true)} data-testid="incidents-open-new">
            <Plus className="h-4 w-4 me-2" />
            {t("admin.incidents.openIncident")}
          </Button>
        </div>
      </div>

      {overdueCount > 0 && (
        <div
          className="flex items-center gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive"
          data-testid="incidents-overdue-banner"
        >
          <AlertTriangle className="h-5 w-5 shrink-0" />
          <span>{t("admin.incidents.overdueBanner").replace("{count}", String(overdueCount))}</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex justify-center p-8">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : incidents.length === 0 ? (
        <p className="text-muted-foreground p-8 text-center">
          {t("admin.incidents.empty")}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("admin.incidents.column.reference")}</TableHead>
                <TableHead>{t("admin.incidents.column.title")}</TableHead>
                <TableHead>{t("admin.incidents.column.severity")}</TableHead>
                <TableHead>{t("admin.incidents.column.status")}</TableHead>
                <TableHead>{t("admin.incidents.column.discovered")}</TableHead>
                <TableHead>{t("admin.incidents.column.customerDue")}</TableHead>
                <TableHead>{t("admin.incidents.column.reportDue")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {incidents.map((incident) => (
                <TableRow
                  key={incident.id}
                  className="cursor-pointer"
                  onClick={() => setSelectedId(incident.id)}
                  data-testid={`incident-row-${incident.reference}`}
                >
                  <TableCell className="font-mono">{incident.reference}</TableCell>
                  <TableCell>{incident.title}</TableCell>
                  <TableCell>
                    <Badge variant={severityVariant(incident.severity)}>
                      {t(`admin.incidents.severity.${incident.severity}`)}
                    </Badge>
                  </TableCell>
                  <TableCell>{t(`admin.incidents.status.${incident.status}`)}</TableCell>
                  <TableCell>{formatDateTime(incident.discoveredAt, language)}</TableCell>
                  <TableCell>
                    <DeadlineCell
                      dueAt={incident.customerNotifyDueAt}
                      doneAt={incident.customerNotifiedAt}
                      overdue={incident.overdue.includes("customer")}
                      locale={language}
                      metLabel={t("admin.incidents.sentAt")}
                    />
                  </TableCell>
                  <TableCell>
                    <DeadlineCell
                      dueAt={incident.investigationReportDueAt}
                      doneAt={incident.investigationReportSentAt}
                      overdue={incident.overdue.includes("investigation_report")}
                      locale={language}
                      metLabel={t("admin.incidents.sentAt")}
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {openFormShown && (
        <OpenIncidentDialog onClose={() => setOpenFormShown(false)} />
      )}
      {selectedId && (
        <IncidentDetailDialog id={selectedId} onClose={() => setSelectedId(null)} />
      )}
    </div>
  );
}

function OpenIncidentDialog({ onClose }: { onClose: () => void }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const openIncident = useOpenIncident();

  const [kind, setKind] = useState<IncidentKind>("phi_breach");
  const [severity, setSeverity] = useState<IncidentSeverity>("high");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [affectedScope, setAffectedScope] = useState("");

  const submit = async () => {
    if (!title.trim()) return;
    try {
      await openIncident.mutateAsync({
        kind,
        severity,
        title: title.trim(),
        description: description.trim() || undefined,
        affectedScope: affectedScope.trim() || undefined,
      });
      toast({ title: t("admin.incidents.opened") });
      onClose();
    } catch {
      toast({ title: t("admin.incidents.openFailed"), variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("admin.incidents.openIncident")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          {/* The clock starts at discovery, which is now unless told otherwise. */}
          <p className="text-sm text-muted-foreground">
            {t("admin.incidents.clockStartsNow")}
          </p>
          <div>
            <Label>{t("admin.incidents.field.kind")}</Label>
            <Select value={kind} onValueChange={(v) => setKind(v as IncidentKind)}>
              <SelectTrigger data-testid="incident-kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {KINDS.map((k) => (
                  <SelectItem key={k} value={k}>
                    {t(`admin.incidents.kind.${k}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("admin.incidents.field.severity")}</Label>
            <Select
              value={severity}
              onValueChange={(v) => setSeverity(v as IncidentSeverity)}
            >
              <SelectTrigger data-testid="incident-severity">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {SEVERITIES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {t(`admin.incidents.severity.${s}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label>{t("admin.incidents.field.title")}</Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              data-testid="incident-title"
            />
          </div>
          <div>
            <Label>{t("admin.incidents.field.description")}</Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              data-testid="incident-description"
            />
          </div>
          <div>
            <Label>{t("admin.incidents.field.affectedScope")}</Label>
            <Textarea
              value={affectedScope}
              onChange={(e) => setAffectedScope(e.target.value)}
              rows={2}
              data-testid="incident-scope"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={!title.trim() || openIncident.isPending}
            data-testid="incident-submit"
          >
            {openIncident.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
            {t("admin.incidents.openIncident")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function IncidentDetailDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t, language } = useLanguage();
  const { toast } = useToast();
  const { data, isLoading } = useSecurityIncident(id);
  const update = useUpdateIncident(id);
  const addNote = useAddIncidentNote(id);
  const closeIncident = useCloseIncident(id);

  const [note, setNote] = useState("");
  const [notifyShown, setNotifyShown] = useState(false);

  const incident = data?.incident;
  const timeline = data?.timeline ?? [];

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {incident ? `${incident.reference} — ${incident.title}` : t("common.loading")}
          </DialogTitle>
        </DialogHeader>

        {isLoading || !incident ? (
          <div className="flex justify-center p-8">
            <Loader2 className="h-6 w-6 animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            {incident.overdue.length > 0 && (
              <div className="flex items-center gap-2 rounded-md border border-destructive bg-destructive/10 p-3 text-destructive">
                <AlertTriangle className="h-5 w-5 shrink-0" />
                <span>
                  {t("admin.incidents.overdueList")}{" "}
                  {incident.overdue
                    .map((o) => t(`admin.incidents.obligation.${o}`))
                    .join(", ")}
                </span>
              </div>
            )}

            <dl className="grid grid-cols-2 gap-2 text-sm">
              <dt className="text-muted-foreground">{t("admin.incidents.field.kind")}</dt>
              <dd>{t(`admin.incidents.kind.${incident.kind}`)}</dd>
              <dt className="text-muted-foreground">
                {t("admin.incidents.column.discovered")}
              </dt>
              <dd>{formatDateTime(incident.discoveredAt, language)}</dd>
              <dt className="text-muted-foreground">
                {t("admin.incidents.field.endedAt")}
              </dt>
              <dd>{formatDateTime(incident.endedAt, language)}</dd>
              <dt className="text-muted-foreground">
                {t("admin.incidents.column.customerDue")}
              </dt>
              <dd>{formatDateTime(incident.customerNotifyDueAt, language)}</dd>
              <dt className="text-muted-foreground">
                {t("admin.incidents.column.reportDue")}
              </dt>
              <dd>{formatDateTime(incident.investigationReportDueAt, language)}</dd>
            </dl>

            <div className="flex flex-wrap items-end gap-2">
              <div>
                <Label>{t("admin.incidents.field.status")}</Label>
                <Select
                  value={incident.status}
                  onValueChange={(v) => update.mutate({ status: v })}
                >
                  <SelectTrigger className="w-48" data-testid="incident-status">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUSES.map((s) => (
                      <SelectItem key={s} value={s}>
                        {t(`admin.incidents.status.${s}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* Ending the event is what starts the 3-day report clock. */}
              <Button
                variant="outline"
                onClick={() => update.mutate({ endedAt: new Date().toISOString() })}
                disabled={Boolean(incident.endedAt)}
                data-testid="incident-mark-ended"
              >
                {t("admin.incidents.markEnded")}
              </Button>
              <Button onClick={() => setNotifyShown(true)} data-testid="incident-notify">
                <Send className="h-4 w-4 me-2" />
                {t("admin.incidents.notify")}
              </Button>
            </div>

            <div>
              <h3 className="font-semibold mb-2">{t("admin.incidents.timeline")}</h3>
              <ul className="space-y-2 text-sm">
                {timeline.map((event) => (
                  <li key={event.id} className="border-s-2 ps-3">
                    <div className="text-muted-foreground">
                      {formatDateTime(event.createdAt, language)} ·{" "}
                      {t(`admin.incidents.event.${event.kind}`)}
                    </div>
                    {event.body && <div>{event.body}</div>}
                  </li>
                ))}
              </ul>
            </div>

            <div className="space-y-2">
              <Label>{t("admin.incidents.addNote")}</Label>
              <Textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                data-testid="incident-note"
              />
              <Button
                variant="outline"
                disabled={!note.trim() || addNote.isPending}
                onClick={async () => {
                  await addNote.mutateAsync(note.trim());
                  setNote("");
                }}
              >
                {t("admin.incidents.addNote")}
              </Button>
            </div>
          </div>
        )}

        {notifyShown && incident && (
          <NotifyDialog incident={incident} onClose={() => setNotifyShown(false)} />
        )}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Preview-then-send. The preview button is always available; the send button
 * only appears once a preview has come back clean, so nobody discovers what
 * the letter says by mailing it to a customer.
 */
function NotifyDialog({
  incident,
  onClose,
}: {
  incident: SecurityIncident;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const notify = useNotifyIncident(incident.id);

  const [target, setTarget] = useState<
    "customer" | "regulator" | "investigation_report"
  >("customer");
  const [recipients, setRecipients] = useState("");
  const [locale, setLocale] = useState<"he" | "en">("he");
  const [vars, setVars] = useState<Record<string, string>>({});
  const [result, setResult] = useState<NotifyResponse | null>(null);

  const recipientList = recipients
    .split(/[,\s]+/)
    .map((r) => r.trim())
    .filter(Boolean);

  const missing = result?.outcome === "unfilled_tokens" ? result.missingTokens ?? [] : [];
  const previewClean = result?.outcome === "preview";

  const run = async (dryRun: boolean) => {
    const res = await notify.mutateAsync({
      target,
      recipients: recipientList,
      locale,
      vars,
      dryRun,
    });
    setResult(res);
    if (res.outcome === "sent") {
      toast({ title: t("admin.incidents.notifySent") });
      onClose();
    } else if (res.outcome === "send_failed") {
      toast({ title: t("admin.incidents.notifyFailed"), variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("admin.incidents.notify")}</DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <div>
            <Label>{t("admin.incidents.field.target")}</Label>
            <Select value={target} onValueChange={(v) => setTarget(v as typeof target)}>
              <SelectTrigger data-testid="notify-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="customer">
                  {t("admin.incidents.obligation.customer")}
                </SelectItem>
                <SelectItem value="regulator">
                  {t("admin.incidents.obligation.regulator")}
                </SelectItem>
                <SelectItem value="investigation_report">
                  {t("admin.incidents.obligation.investigation_report")}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label>{t("admin.incidents.field.recipients")}</Label>
            <Input
              value={recipients}
              onChange={(e) => setRecipients(e.target.value)}
              placeholder={t("admin.incidents.recipientsPlaceholder")}
              data-testid="notify-recipients"
            />
          </div>

          <div>
            <Label>{t("admin.incidents.field.locale")}</Label>
            <Select value={locale} onValueChange={(v) => setLocale(v as "he" | "en")}>
              <SelectTrigger data-testid="notify-locale">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="he">{t("admin.incidents.locale.he")}</SelectItem>
                <SelectItem value="en">{t("admin.incidents.locale.en")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {missing.length > 0 && (
            <div className="space-y-2 rounded-md border p-3">
              <p className="text-sm font-medium">
                {t("admin.incidents.fillTokens")}
              </p>
              {missing.map((token) => (
                <div key={token}>
                  <Label className="font-mono text-xs">{token}</Label>
                  <Textarea
                    rows={2}
                    value={vars[token] ?? ""}
                    onChange={(e) =>
                      setVars((prev) => ({ ...prev, [token]: e.target.value }))
                    }
                    data-testid={`notify-token-${token}`}
                  />
                </div>
              ))}
            </div>
          )}

          {result?.text && (
            <div className="rounded-md border p-3">
              <p className="text-sm font-medium">{result.subject}</p>
              <pre className="mt-2 whitespace-pre-wrap text-xs">{result.text}</pre>
            </div>
          )}

          {result?.outcome === "send_failed" && (
            <p className="text-sm text-destructive">
              {t("admin.incidents.sendFailedDetail")}{" "}
              {(result.failedRecipients ?? []).join(", ")}
            </p>
          )}
        </div>

        <DialogFooter className="gap-2">
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => void run(true)}
            disabled={recipientList.length === 0 || notify.isPending}
            data-testid="notify-preview"
          >
            <Eye className="h-4 w-4 me-2" />
            {t("admin.incidents.preview")}
          </Button>
          {/* Only offered once a preview came back with nothing missing. */}
          {previewClean && (
            <Button
              variant="destructive"
              onClick={() => void run(false)}
              disabled={notify.isPending}
              data-testid="notify-send"
            >
              {notify.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
              <Send className="h-4 w-4 me-2" />
              {t("admin.incidents.sendForReal")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
