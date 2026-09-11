// client/src/features/consent/ConsentHistoryPanel.tsx
//
// Audit-grade per-student consent history. Read-only timeline of every
// consent record (active + revoked), with a revoke button on the active
// record. Lives inside StudentInfoPanel as a collapsible section.

import { useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { describeConsentError } from "./sign-error";
import { useToast } from "@/hooks/use-toast";
import {
  useRevokeConsent,
  useReissueWithdrawalLink,
  type StudentConsentRecord,
} from "@/hooks/useConsentApi";
import { useConsentDetail } from "@/features/consent/ConsentProvider";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { ChevronDown, History, ShieldCheck, ShieldOff, AlertCircle } from "lucide-react";

interface ConsentHistoryPanelProps {
  studentId: string;
}

export function ConsentHistoryPanel({ studentId }: ConsentHistoryPanelProps) {
  const { t } = useLanguage();
  // Reads the shared observer rather than opening its own — see
  // features/consent/ConsentProvider.tsx.
  const { history: slice } = useConsentDetail();
  const [open, setOpen] = useState(false);

  // A failed read is not an empty history; the panel above reports it.
  if (!slice.isSettled || slice.isError) return null;
  const history = slice.data ?? [];
  if (history.length === 0) return null;

  const active = history.find((r) => !r.revokedAt);
  const revokedCount = history.filter((r) => r.revokedAt).length;

  return (
    <Card>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <CardHeader className="cursor-pointer hover:bg-muted/30">
            <div className="flex items-center justify-between">
              <CardTitle className="flex items-center gap-2">
                <History className="w-5 h-5" />
                {t("consent.history.title") || "Consent history"}
              </CardTitle>
              <div className="flex items-center gap-2">
                {active ? (
                  <Badge variant="secondary">{t("consent.history.activeBadge") || "Active"}</Badge>
                ) : (
                  <Badge variant="outline">{t("consent.history.noneActiveBadge") || "None active"}</Badge>
                )}
                {revokedCount > 0 && (
                  <Badge variant="outline">
                    {revokedCount} {t("consent.history.revokedSuffix") || "revoked"}
                  </Badge>
                )}
                <ChevronDown className={`h-4 w-4 transition-transform ${open ? "rotate-180" : ""}`} />
              </div>
            </div>
          </CardHeader>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <CardContent className="space-y-3">
            {history.map((rec) => (
              <ConsentRecordRow key={rec.id} record={rec} studentId={studentId} />
            ))}
          </CardContent>
        </CollapsibleContent>
      </Collapsible>
    </Card>
  );
}

function ConsentRecordRow({ record, studentId }: { record: StudentConsentRecord; studentId: string }) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const revoke = useRevokeConsent();
  const sendWithdrawalLink = useReissueWithdrawalLink();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [reason, setReason] = useState("");
  const isActive = !record.revokedAt;

  // The guardian phoned, or lost the receipt email. This re-sends a one-time
  // withdrawal link to the channel already on file for the SIGNER (§5.3) — the
  // clinician never sees the code, so this is not a back door into revoking a
  // parent-signed consent from the clinic side. That rule is still §5.2's.
  async function handleSendWithdrawalLink() {
    try {
      const out = await sendWithdrawalLink.mutateAsync({ consentId: record.id });
      toast({
        title: t("consent.history.withdrawalLinkSent"),
        description: `${t("consent.history.withdrawalLinkSentTo")}: ${out.sentTo}`,
      });
    } catch (e: any) {
      toast({
        title: t("consent.history.withdrawalLinkFailed"),
        description: describeConsentError(e, t),
        variant: "destructive",
      });
    }
  }

  async function handleRevoke() {
    try {
      await revoke.mutateAsync({ consentId: record.id, reason: reason || undefined });
      toast({ title: t("consent.history.toastRevoked") || "Consent revoked" });
      setConfirmOpen(false);
    } catch (e: any) {
      toast({
        title: t("consent.history.toastRevokeFailed") || "Could not revoke",
        description: describeConsentError(e, t),
        variant: "destructive",
      });
    }
  }

  const optInsOn = [
    record.optInModelTraining ? "model_training" : null,
    record.optInAdvertising ? "advertising" : null,
    record.optInThirdPartyResearch ? "third_party_research" : null,
    record.optInMarketingComms ? "marketing_comms" : null,
  ].filter(Boolean) as string[];

  return (
    <div className={`rounded-md border p-3 ${isActive ? "border-green-500/50 bg-green-50/30 dark:bg-green-950/10" : "border-muted bg-muted/20"}`}>
      <div className="flex items-start gap-3">
        {isActive ? (
          <ShieldCheck className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
        ) : (
          <ShieldOff className="w-5 h-5 text-muted-foreground mt-0.5 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0 text-sm space-y-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium">
              {(t("consent.history.signedOn") || "Signed")} {formatDate(record.signedAt)}
            </span>
            <Badge variant="outline" className="text-xs">{record.consentTextVersion}</Badge>
            <Badge variant="outline" className="text-xs">{record.country}</Badge>
            {record.enhancedProtectionRegime && (
              <Badge variant="outline" className="text-xs">{record.enhancedProtectionRegime}</Badge>
            )}
            {record.optInsForcedOff && (
              <Badge variant="outline" className="text-xs flex items-center gap-1">
                <AlertCircle className="h-3 w-3" />
                {t("consent.history.optInsForcedOff") || "opt-ins forced off"}
              </Badge>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {(t("consent.history.idvLabel") || "Verified via")}: {record.identityVerificationMethod}
            {record.nonRepudiationMethod !== record.identityVerificationMethod &&
              ` + ${record.nonRepudiationMethod}`}
          </p>
          <p className="text-xs text-muted-foreground">
            {(t("consent.history.optInsLabel") || "Opt-ins")}:{" "}
            {optInsOn.length > 0 ? optInsOn.join(", ") : (t("consent.history.optInsNone") || "none")}
          </p>
          {record.revokedAt && (
            <p className="text-xs text-amber-600">
              {(t("consent.history.revokedOn") || "Revoked")} {formatDate(record.revokedAt)}
              {record.revocationReason ? ` — ${record.revocationReason}` : ""}
            </p>
          )}
        </div>
        {/* `canRevoke` is the SERVER's answer (see useConsentApi's note on the
            field): this panel is visible to any institute member, but revoking
            wants the signer, a system admin, or — on a clinician-attested
            record only — someone who could have attested it. Offering the
            button to everyone meant a confident click and a 403 toast. Absent
            flag = not permitted. */}
        <div className="flex flex-col gap-2 items-stretch">
          {isActive && record.canRevoke && (
            <Button variant="outline" size="sm" onClick={() => setConfirmOpen(true)}>
              {t("consent.history.revokeAction") || "Revoke"}
            </Button>
          )}
          {/* Server-computed, exactly like `canRevoke` above — the client cannot
              see whether the signer has an account or a reachable channel. */}
          {isActive && record.canSendWithdrawalLink && (
            <Button
              variant="ghost"
              size="sm"
              onClick={handleSendWithdrawalLink}
              disabled={sendWithdrawalLink.isPending}
              title={t("consent.history.withdrawalLinkHint")}
            >
              {sendWithdrawalLink.isPending
                ? t("common.saving")
                : t("consent.history.sendWithdrawalLink")}
            </Button>
          )}
        </div>
      </div>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("consent.history.revokeConfirmTitle") || "Revoke consent?"}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("consent.history.revokeConfirmDescription") ||
                "Revoking will return the student to consent-pending state. Active shares for this student will be revoked, and any in-flight AAC session will be terminated. This cannot be undone — re-consent requires a new signing flow."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <input
            type="text"
            placeholder={t("consent.history.revokeReasonPlaceholder") || "Reason (optional)"}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="w-full border rounded-md px-3 py-2 text-sm"
          />
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common.cancel") || "Cancel"}</AlertDialogCancel>
            <AlertDialogAction onClick={handleRevoke} disabled={revoke.isPending}>
              {revoke.isPending
                ? t("common.saving") || "Saving..."
                : t("consent.history.revokeConfirm") || "Revoke consent"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function formatDate(iso: string | Date): string {
  const d = iso instanceof Date ? iso : new Date(iso);
  return d.toISOString().split("T")[0];
}
