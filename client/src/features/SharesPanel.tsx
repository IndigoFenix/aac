// src/features/SharesPanel.tsx
//
// Clinician-side UI for cross-institute sharing.
//
// Three tabs:
//   - Outgoing: shares this institute is the source of
//   - Incoming: shares this institute received (or is mid-redemption on)
//   - Inbox:    invites awaiting the current user as named guardian
//
// Each row exposes the relevant lifecycle actions (approve/decline, redeem,
// accept, revoke). The "Create share" dialog is a deliberately small MVP —
// callers paste an object id and pick a type. A richer object picker (drawn
// from the current student's records) is the natural follow-up.

import { useEffect, useMemo, useState } from "react";
import { useSearch } from "wouter";
import { useInstitute } from "@/hooks/useInstitute";
import { useStudent } from "@/hooks/useStudent";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  useShareInvites,
  useGuardianInbox,
  useApproveShareInvite,
  useDeclineShareInvite,
  useRedeemShareCode,
  useAcceptShareInvite,
  useRevokeShareInvite,
  useStandingSharesInbox,
  useRenewStandingShare,
  useBulkRevokeShares,
  useActiveShares,
  useRevokeObjectShare,
  useRevokeStandingShare,
  type StudentShareInvite,
  type ShareInviteBundle,
  type StandingShareWithInvite,
  type ObjectShare,
  type StandingShare,
} from "@/hooks/useSharesApi";
import { CreateShareDialog } from "@/features/sharing/CreateShareDialog";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
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
  Share2,
  KeyRound,
  Check,
  X,
  AlertTriangle,
  Trash2,
  ChevronDown,
  ChevronRight,
} from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";

interface SharesPanelProps {
  isOpen?: boolean;
}

const STATUS_VARIANTS: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending_guardian: "secondary",
  pending_target: "secondary",
  pending_target_confirm: "secondary",
  accepted: "default",
  declined: "outline",
  revoked: "destructive",
  expired: "outline",
};

type SharesTab = "outgoing" | "incoming" | "inbox";

const VALID_TABS: SharesTab[] = ["outgoing", "incoming", "inbox"];

function parseTabFromSearch(search: string): SharesTab | undefined {
  const param = new URLSearchParams(search).get("tab");
  return VALID_TABS.includes(param as SharesTab) ? (param as SharesTab) : undefined;
}

export function SharesPanel(_props: SharesPanelProps) {
  const { t } = useLanguage();
  const { currentInstitute } = useInstitute();
  const { student } = useStudent();
  const instituteId = currentInstitute?.id;

  // Deep-link via `?tab=`: bell + future entry points can land users directly
  // on the Inbox / Incoming tab. Falls back to Outgoing when the param is
  // absent or unrecognized.
  const search = useSearch();
  const [tab, setTab] = useState<SharesTab>(() => parseTabFromSearch(search) ?? "outgoing");

  // Re-sync when the search string changes after mount — handles the case
  // where the bell is clicked while already on /shares.
  useEffect(() => {
    const fromSearch = parseTabFromSearch(search);
    if (fromSearch && fromSearch !== tab) setTab(fromSearch);
    // Intentionally not in deps: we only want to react to URL changes, not
    // local tab switches (which would loop).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search]);
  const [redeemOpen, setRedeemOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [acceptInvite, setAcceptInvite] = useState<StudentShareInvite | null>(null);
  const [approveInvite, setApproveInvite] = useState<StudentShareInvite | null>(null);

  return (
    <div className="flex flex-col h-full overflow-hidden">
      <div className="flex items-center justify-between p-4 border-b">
        <div className="flex items-center gap-2">
          <Share2 className="h-5 w-5" />
          <h2 className="text-lg font-semibold">{t("shares.title")}</h2>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={() => setRedeemOpen(true)}>
            <KeyRound className="h-4 w-4 me-2" />
            {t("shares.actions.redeem")}
          </Button>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Share2 className="h-4 w-4 me-2" />
            {t("shares.actions.create")}
          </Button>
        </div>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)} className="flex-1 flex flex-col overflow-hidden">
        <TabsList className="m-4">
          <TabsTrigger value="outgoing">{t("shares.tabs.outgoing")}</TabsTrigger>
          <TabsTrigger value="incoming">{t("shares.tabs.incoming")}</TabsTrigger>
          <TabsTrigger value="inbox">{t("shares.tabs.inbox")}</TabsTrigger>
        </TabsList>

        <TabsContent value="outgoing" className="flex-1 overflow-auto px-4 pb-4 space-y-6">
          <section>
            <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
              {t("shares.outgoing.invitesHeader")}
            </h3>
            <InvitesList
              role="outgoing"
              instituteId={instituteId}
              onAccept={setAcceptInvite}
            />
          </section>
          <section>
            <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
              {t("shares.outgoing.activeHeader")}
            </h3>
            <ActiveSharesList role="source" instituteId={instituteId} />
          </section>
        </TabsContent>
        <TabsContent value="incoming" className="flex-1 overflow-auto px-4 pb-4 space-y-6">
          <section>
            <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
              {t("shares.incoming.invitesHeader")}
            </h3>
            <InvitesList
              role="incoming"
              instituteId={instituteId}
              onAccept={setAcceptInvite}
            />
          </section>
          <section>
            <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
              {t("shares.incoming.activeHeader")}
            </h3>
            <ActiveSharesList role="target" instituteId={instituteId} />
          </section>
        </TabsContent>
        <TabsContent value="inbox" className="flex-1 overflow-auto px-4 pb-4 space-y-6">
          <section>
            <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
              {t("shares.inbox.pendingHeader")}
            </h3>
            <GuardianInboxList onApprove={setApproveInvite} />
          </section>
          <section>
            <h3 className="text-sm font-semibold mb-2 text-muted-foreground">
              {t("shares.inbox.standingHeader")}
            </h3>
            <StandingSharesList />
          </section>
        </TabsContent>
      </Tabs>

      {redeemOpen && (
        <RedeemDialog
          instituteId={instituteId}
          onClose={() => setRedeemOpen(false)}
          onRedeemed={(invite) => {
            setRedeemOpen(false);
            setAcceptInvite(invite);
          }}
        />
      )}

      {createOpen && student?.id && instituteId && (
        <CreateShareDialog
          studentId={student.id}
          sourceInstituteId={instituteId}
          onClose={() => setCreateOpen(false)}
        />
      )}

      {acceptInvite && (
        <AcceptDialog
          invite={acceptInvite}
          onClose={() => setAcceptInvite(null)}
        />
      )}

      {approveInvite && (
        <GuardianApproveDialog
          invite={approveInvite}
          onClose={() => setApproveInvite(null)}
        />
      )}
    </div>
  );
}

// =============================================================================
// Invites list (outgoing / incoming)
// =============================================================================

function InvitesList({
  role,
  instituteId,
  onAccept,
}: {
  role: "outgoing" | "incoming";
  instituteId: string | undefined;
  onAccept: (invite: StudentShareInvite) => void;
}) {
  const { t } = useLanguage();
  const { data, isLoading } = useShareInvites(
    role === "outgoing" ? "source" : "target",
    instituteId,
  );
  const revoke = useRevokeShareInvite();

  if (!instituteId) {
    return <Empty msg={t("shares.empty.noInstitute")} />;
  }
  if (isLoading) return <Empty msg={t("common.loading")} />;
  const invites = data?.invites ?? [];
  if (invites.length === 0) return <Empty msg={t("shares.empty.noInvites")} />;

  return (
    <div className="space-y-3">
      {invites.map((inv) => (
        <Card key={inv.id} className="p-0">
          <CardHeader className="pb-2">
            <div className="flex items-center justify-between gap-2">
              <CardTitle className="text-sm font-medium">
                {t(`shares.objectType.summary`)}: {summarizeBundle(inv.pendingBundle)}
              </CardTitle>
              <Badge variant={STATUS_VARIANTS[inv.status] ?? "secondary"}>
                {t(`shares.status.${inv.status}`)}
              </Badge>
            </div>
          </CardHeader>
          <CardContent className="text-sm space-y-1 pb-3">
            <div className="text-muted-foreground">
              {t("shares.field.codeExpires")}: {fmt(inv.codeExpiresAt)}
              {inv.shareExpiresAt && (
                <>
                  {" • "}
                  {t("shares.field.shareExpires")}: {fmt(inv.shareExpiresAt)}
                </>
              )}
            </div>
            {inv.message && (
              <div className="text-muted-foreground italic">"{inv.message}"</div>
            )}
            <div className="flex gap-2 pt-2">
              {role === "incoming" && inv.status === "pending_target_confirm" && (
                <Button size="sm" onClick={() => onAccept(inv)}>
                  {t("shares.actions.review")}
                </Button>
              )}
              {(inv.status === "accepted" ||
                inv.status === "pending_guardian" ||
                inv.status === "pending_target" ||
                inv.status === "pending_target_confirm") && (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => revoke.mutate({ inviteId: inv.id })}
                  disabled={revoke.isPending}
                >
                  <Trash2 className="h-4 w-4 me-1" />
                  {t("shares.actions.revoke")}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

// =============================================================================
// Guardian inbox
// =============================================================================

function GuardianInboxList({
  onApprove,
}: {
  onApprove: (invite: StudentShareInvite) => void;
}) {
  const { t } = useLanguage();
  const { data, isLoading } = useGuardianInbox();
  if (isLoading) return <Empty msg={t("common.loading")} />;
  const invites = data?.invites ?? [];
  if (invites.length === 0) return <Empty msg={t("shares.empty.inbox")} />;

  return (
    <div className="space-y-3">
      {invites.map((inv) => {
        const sensitiveCount = inv.pendingBundle.objects.filter((o) => o.isSensitive).length;
        return (
          <Card key={inv.id} className="p-0">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium">
                  {summarizeBundle(inv.pendingBundle)}
                </CardTitle>
                {sensitiveCount > 0 && (
                  <Badge variant="destructive" className="gap-1">
                    <AlertTriangle className="h-3 w-3" />
                    {t("shares.field.sensitiveCount", { count: sensitiveCount })}
                  </Badge>
                )}
              </div>
            </CardHeader>
            <CardContent className="text-sm pb-3">
              {inv.message && (
                <div className="text-muted-foreground italic mb-2">"{inv.message}"</div>
              )}
              <Button size="sm" onClick={() => onApprove(inv)}>
                {t("shares.actions.review")}
              </Button>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}

// Threshold for surfacing the "Renew" button. A standing share inside this
// many days of expiry is considered actionable. Past expiry is also actionable
// (renewal extends from now, not from the old expiry).
const RENEW_THRESHOLD_DAYS = 90;

function StandingSharesList() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const { data, isLoading } = useStandingSharesInbox();
  const renew = useRenewStandingShare();
  const [bulkRevokeTarget, setBulkRevokeTarget] = useState<{
    studentId: string;
    targetInstituteId: string;
  } | null>(null);

  if (isLoading) return <Empty msg={t("common.loading")} />;
  const rows = (data?.shares ?? []).filter((r) => !r.share.revokedAt);
  if (rows.length === 0) return <Empty msg={t("shares.empty.standing")} />;

  // Sort: most-urgent first (soonest expiry, expired rows at the very top).
  const sorted = [...rows].sort(
    (a, b) =>
      new Date(a.share.shareExpiresAt).getTime() -
      new Date(b.share.shareExpiresAt).getTime(),
  );

  return (
    <div className="space-y-3">
      {sorted.map(({ share, invite }) => {
        const expiresAt = new Date(share.shareExpiresAt);
        const daysUntilExpiry = Math.ceil(
          (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
        );
        const isExpired = daysUntilExpiry < 0;
        const isExpiring = !isExpired && daysUntilExpiry <= RENEW_THRESHOLD_DAYS;

        const badgeVariant = isExpired ? "destructive" : isExpiring ? "secondary" : "outline";
        const badgeText = isExpired
          ? t("shares.standing.expired")
          : t("shares.standing.expiresInDays", { days: daysUntilExpiry });

        return (
          <Card key={share.id} className="p-0">
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium">
                  {share.objectTypes.map((tt) => t(`shares.objectType.${tt}`)).join(", ")}
                </CardTitle>
                <Badge variant={badgeVariant}>{badgeText}</Badge>
              </div>
            </CardHeader>
            <CardContent className="text-sm pb-3 space-y-2">
              <div className="text-muted-foreground">
                {t("shares.standing.expiresOn", {
                  date: expiresAt.toLocaleDateString(),
                })}
              </div>
              {invite.message && (
                <div className="text-muted-foreground italic">"{invite.message}"</div>
              )}
              <div className="flex flex-wrap gap-2">
                {(isExpired || isExpiring) && (
                  <Button
                    size="sm"
                    disabled={renew.isPending}
                    onClick={() =>
                      renew.mutate(
                        { standingShareId: share.id },
                        {
                          onSuccess: () =>
                            toast({ title: t("shares.standing.renewedToast") }),
                        },
                      )
                    }
                  >
                    {t("shares.actions.renew")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    setBulkRevokeTarget({
                      studentId: share.studentId,
                      targetInstituteId: share.targetInstituteId,
                    })
                  }
                >
                  <Trash2 className="h-4 w-4 me-1" />
                  {t("shares.actions.revokeAll")}
                </Button>
              </div>
            </CardContent>
          </Card>
        );
      })}
      {bulkRevokeTarget && (
        <BulkRevokeDialog
          studentId={bulkRevokeTarget.studentId}
          targetInstituteId={bulkRevokeTarget.targetInstituteId}
          onClose={() => setBulkRevokeTarget(null)}
        />
      )}
    </div>
  );
}

function BulkRevokeDialog({
  studentId,
  targetInstituteId,
  onClose,
}: {
  studentId: string;
  targetInstituteId: string;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const bulkRevoke = useBulkRevokeShares();

  const submit = () => {
    bulkRevoke.mutate(
      { studentId, targetInstituteId },
      {
        onSuccess: (res) => {
          const total = res.objectSharesRevoked + res.standingSharesRevoked;
          toast({
            title: t("shares.bulkRevoke.toastSuccess", { count: total }),
          });
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("shares.bulkRevoke.title")}</DialogTitle>
          <DialogDescription>{t("shares.bulkRevoke.description")}</DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="destructive"
            disabled={bulkRevoke.isPending}
            onClick={submit}
          >
            {t("shares.bulkRevoke.confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Materialized active shares for an institute (source or target role). Grouped
 * per-student as collapsible cards: outer header shows student name + total
 * count, expanding reveals the per-object and standing share lists. Per-grant
 * Revoke remains available on each row.
 *
 * The per-student grouping scales better than a flat list when an institute
 * has dozens of students with shares.
 */
function ActiveSharesList({
  role,
  instituteId,
}: {
  role: "source" | "target";
  instituteId: string | undefined;
}) {
  const { t } = useLanguage();
  const { data, isLoading } = useActiveShares(role, instituteId);

  if (!instituteId) return <Empty msg={t("shares.empty.noInstitute")} />;
  if (isLoading) return <Empty msg={t("common.loading")} />;

  const objectShares = data?.objectShares ?? [];
  const standingShares = data?.standingShares ?? [];
  const studentLabels = data?.students ?? {};

  if (objectShares.length === 0 && standingShares.length === 0) {
    return <Empty msg={t("shares.empty.activeShares")} />;
  }

  // Group by studentId. The set of studentIds is the union of those touched
  // by object and standing shares; sort by display name for stable order.
  const studentIds = Array.from(
    new Set([
      ...objectShares.map((s) => s.studentId),
      ...standingShares.map((s) => s.studentId),
    ]),
  ).sort((a, b) => {
    const an = studentLabels[a]?.name ?? a;
    const bn = studentLabels[b]?.name ?? b;
    return an.localeCompare(bn);
  });

  return (
    <div className="space-y-2">
      {studentIds.map((sid) => {
        const studentObjects = objectShares.filter((s) => s.studentId === sid);
        const studentStandings = standingShares.filter((s) => s.studentId === sid);
        const total = studentObjects.length + studentStandings.length;
        const label = studentLabels[sid]?.name ?? sid;
        return (
          <StudentShareGroup
            key={sid}
            studentLabel={label}
            count={total}
            role={role}
            objectShares={studentObjects}
            standingShares={studentStandings}
          />
        );
      })}
    </div>
  );
}

function StudentShareGroup({
  studentLabel,
  count,
  role,
  objectShares,
  standingShares,
}: {
  studentLabel: string;
  count: number;
  role: "source" | "target";
  objectShares: ObjectShare[];
  standingShares: StandingShare[];
}) {
  const { t } = useLanguage();
  const [open, setOpen] = useState(true);
  const revokeObject = useRevokeObjectShare();
  const revokeStanding = useRevokeStandingShare();

  return (
    <Collapsible open={open} onOpenChange={setOpen} asChild>
      <Card className="p-0">
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="w-full text-start flex items-center justify-between gap-2 px-4 py-3 hover:bg-muted/40 rounded-md"
          >
            <span className="flex items-center gap-2 font-medium text-sm">
              {open ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
              {studentLabel}
            </span>
            <Badge variant="secondary">{count}</Badge>
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="px-4 pb-3 space-y-3 border-t pt-3">
            {objectShares.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t("shares.active.objectSharesHeader")}
                </div>
                {objectShares.map((s) => (
                  <ObjectShareRow
                    key={s.id}
                    share={s}
                    role={role}
                    onRevoke={() => revokeObject.mutate({ objectShareId: s.id })}
                    disabled={revokeObject.isPending}
                  />
                ))}
              </div>
            )}
            {standingShares.length > 0 && (
              <div className="space-y-2">
                <div className="text-xs uppercase tracking-wide text-muted-foreground">
                  {t("shares.active.standingSharesHeader")}
                </div>
                {standingShares.map((s) => (
                  <StandingShareRow
                    key={s.id}
                    share={s}
                    role={role}
                    onRevoke={() => revokeStanding.mutate({ standingShareId: s.id })}
                    disabled={revokeStanding.isPending}
                  />
                ))}
              </div>
            )}
          </div>
        </CollapsibleContent>
      </Card>
    </Collapsible>
  );
}

function ObjectShareRow({
  share,
  role,
  onRevoke,
  disabled,
}: {
  share: ObjectShare;
  role: "source" | "target";
  onRevoke: () => void;
  disabled: boolean;
}) {
  const { t } = useLanguage();
  const expiresAt = share.shareExpiresAt ? new Date(share.shareExpiresAt) : null;
  return (
    <Card className="p-0">
      <CardContent className="text-sm py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">
            {t(`shares.objectType.${share.objectType}`)}
            <span className="ms-2 text-muted-foreground text-xs">
              {t(`shares.permission.${share.permission}`)}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {expiresAt
              ? t("shares.standing.expiresOn", { date: expiresAt.toLocaleDateString() })
              : t("shares.active.noExpiry")}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onRevoke}
          aria-label={t("shares.actions.revoke")}
        >
          <Trash2 className="h-4 w-4 me-1" />
          {t("shares.actions.revoke")}
        </Button>
      </CardContent>
    </Card>
  );
}

function StandingShareRow({
  share,
  role,
  onRevoke,
  disabled,
}: {
  share: StandingShare;
  role: "source" | "target";
  onRevoke: () => void;
  disabled: boolean;
}) {
  const { t } = useLanguage();
  const expiresAt = new Date(share.shareExpiresAt);
  const daysUntilExpiry = Math.ceil(
    (expiresAt.getTime() - Date.now()) / (1000 * 60 * 60 * 24),
  );
  const isExpired = daysUntilExpiry < 0;
  return (
    <Card className="p-0">
      <CardContent className="text-sm py-3 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="font-medium">
            {share.objectTypes.map((tt) => t(`shares.objectType.${tt}`)).join(", ")}
            <span className="ms-2 text-muted-foreground text-xs">
              {t(`shares.permission.${share.permission}`)}
            </span>
          </div>
          <div className="text-xs text-muted-foreground">
            {isExpired
              ? t("shares.standing.expired")
              : t("shares.standing.expiresOn", { date: expiresAt.toLocaleDateString() })}
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled}
          onClick={onRevoke}
          aria-label={t("shares.actions.revoke")}
        >
          <Trash2 className="h-4 w-4 me-1" />
          {t("shares.actions.revoke")}
        </Button>
      </CardContent>
    </Card>
  );
}

// =============================================================================
// Dialogs
// =============================================================================

function RedeemDialog({
  instituteId,
  onClose,
  onRedeemed,
}: {
  instituteId: string | undefined;
  onClose: () => void;
  onRedeemed: (invite: StudentShareInvite) => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [code, setCode] = useState("");
  const redeem = useRedeemShareCode();

  const submit = () => {
    if (!instituteId) return;
    redeem.mutate(
      { code: code.trim(), targetInstituteId: instituteId },
      {
        onSuccess: (res) => onRedeemed(res.invite),
        onError: (err) =>
          toast({ title: t("shares.errors.redeem"), description: err.message, variant: "destructive" }),
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("shares.redeem.title")}</DialogTitle>
          <DialogDescription>{t("shares.redeem.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            <div>
              <Label htmlFor="share-code">{t("shares.redeem.codeLabel")}</Label>
              <Input
                id="share-code"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABCDE23456FG"
                autoFocus
              />
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            disabled={!code.trim() || !instituteId || redeem.isPending}
            onClick={submit}
          >
            {t("shares.redeem.submit")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AcceptDialog({
  invite,
  onClose,
}: {
  invite: StudentShareInvite;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const accept = useAcceptShareInvite();
  const decline = useDeclineShareInvite();

  const sensitiveCount = invite.pendingBundle.objects.filter((o) => o.isSensitive).length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("shares.accept.title")}</DialogTitle>
          <DialogDescription>{t("shares.accept.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <BundleSummary bundle={invite.pendingBundle} sensitiveCount={sensitiveCount} />
        </DialogBody>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() =>
              decline.mutate(
                { inviteId: invite.id, by: "target" },
                {
                  onSuccess: () => onClose(),
                  onError: (err) =>
                    toast({
                      title: t("shares.errors.decline"),
                      description: err.message,
                      variant: "destructive",
                    }),
                },
              )
            }
            disabled={decline.isPending}
          >
            <X className="h-4 w-4 me-1" />
            {t("shares.actions.decline")}
          </Button>
          <Button
            onClick={() =>
              accept.mutate(
                { inviteId: invite.id },
                {
                  onSuccess: () => onClose(),
                  onError: (err) =>
                    toast({
                      title: t("shares.errors.accept"),
                      description: err.message,
                      variant: "destructive",
                    }),
                },
              )
            }
            disabled={accept.isPending}
          >
            <Check className="h-4 w-4 me-1" />
            {t("shares.actions.accept")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function GuardianApproveDialog({
  invite,
  onClose,
}: {
  invite: StudentShareInvite;
  onClose: () => void;
}) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const approve = useApproveShareInvite();
  const decline = useDeclineShareInvite();
  const sensitiveCount = invite.pendingBundle.objects.filter((o) => o.isSensitive).length;

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("shares.guardian.title")}</DialogTitle>
          <DialogDescription>{t("shares.guardian.description")}</DialogDescription>
        </DialogHeader>
        <DialogBody>
          <BundleSummary bundle={invite.pendingBundle} sensitiveCount={sensitiveCount} />
        </DialogBody>
        <DialogFooter className="gap-2">
          <Button
            variant="outline"
            onClick={() =>
              decline.mutate(
                { inviteId: invite.id, by: "guardian" },
                {
                  onSuccess: () => onClose(),
                  onError: (err) =>
                    toast({
                      title: t("shares.errors.decline"),
                      description: err.message,
                      variant: "destructive",
                    }),
                },
              )
            }
            disabled={decline.isPending}
          >
            <X className="h-4 w-4 me-1" />
            {t("shares.actions.decline")}
          </Button>
          <Button
            onClick={() =>
              approve.mutate(
                { inviteId: invite.id },
                {
                  onSuccess: () => onClose(),
                  onError: (err) =>
                    toast({
                      title: t("shares.errors.approve"),
                      description: err.message,
                      variant: "destructive",
                    }),
                },
              )
            }
            disabled={approve.isPending}
          >
            <Check className="h-4 w-4 me-1" />
            {t("shares.actions.approve")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}


// =============================================================================
// Small helpers
// =============================================================================

function BundleSummary({
  bundle,
  sensitiveCount,
}: {
  bundle: ShareInviteBundle;
  sensitiveCount: number;
}) {
  const { t } = useLanguage();
  return (
    <div className="border rounded p-3 space-y-2 text-sm">
      <div>
        <strong>{t("shares.bundle.objects")}:</strong>{" "}
        {bundle.objects.length === 0 ? t("common.none") : (
          <ul className="list-disc ms-5">
            {bundle.objects.map((o) => (
              <li key={`${o.type}:${o.id}`} className="font-mono text-xs">
                {t(`shares.objectType.${o.type}`)} — {o.id}
                {o.isSensitive && (
                  <Badge variant="destructive" className="ms-2 text-xs">
                    {t("shares.bundle.sensitive")}
                  </Badge>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {bundle.standingTypes.length > 0 && (
        <div>
          <strong>{t("shares.bundle.standingTypes")}:</strong>{" "}
          {bundle.standingTypes.map((tp) => t(`shares.objectType.${tp}`)).join(", ")}
        </div>
      )}
      <div className="text-muted-foreground">
        {t("shares.bundle.permission")}: {t(`shares.permission.${bundle.permission}`)}
      </div>
      {sensitiveCount > 0 && (
        <div className="text-destructive flex items-center gap-1">
          <AlertTriangle className="h-4 w-4" />
          {t("shares.field.sensitiveCount", { count: sensitiveCount })}
        </div>
      )}
    </div>
  );
}

function Empty({ msg }: { msg: string }) {
  return <div className="text-sm text-muted-foreground p-6 text-center">{msg}</div>;
}

function summarizeBundle(b: ShareInviteBundle): string {
  const parts: string[] = [];
  if (b.objects.length > 0) parts.push(`${b.objects.length} obj`);
  if (b.standingTypes.length > 0) parts.push(`${b.standingTypes.length} types`);
  return parts.join(", ") || "—";
}

function fmt(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleDateString();
}
