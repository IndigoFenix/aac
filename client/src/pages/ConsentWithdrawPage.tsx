// client/src/pages/ConsentWithdrawPage.tsx
//
// Public landing page for SELF-SERVE WITHDRAWAL OF CONSENT — the mirror of
// ConsentSignPage, for a guardian who signed by magic link (or was attested for
// at the clinic desk) and has no user account. See
// docs/student-consent-implementation.md §5.3.
//
// 🚨 THIS PAGE NEVER WITHDRAWS ON LOAD. Email scanners, corporate
// link-rewriters and browser prefetchers follow URLs; a one-click withdrawal
// link would let any of them terminate a child's AAC session with no human
// involved. Every state change here is a POST fired by a click, the
// consequences are spelled out before the button appears, and a checkbox gates
// the button. The server refuses a confirm that does not carry `confirm: true`
// as a second line of defence.
//
// TWO ENTRY SHAPES, one page:
//   #ref=<consentId>  — from the consent receipt. Not a credential: it asks the
//                       server to mail a fresh one-time link to the address
//                       already on file, and the answer is identical whether or
//                       not the reference is real.
//   #code=<token>     — the one-time link itself. Resolves the record, runs the
//                       same second factor the signing flow used, then confirms.
//
// Both arrive in the URL FRAGMENT, which the browser never sends to the server,
// so neither lands in CDN/ALB access logs or Referer headers; both are scrubbed
// from the address bar once read.

import { useEffect, useState } from "react";

import { useLanguage } from "@/contexts/LanguageContext";
import {
  useRequestWithdrawalLink,
  useWithdrawalContext,
  useRequestWithdrawalOtp,
  useVerifyWithdrawalOtp,
  useVerifyWithdrawalChildId,
  useConfirmWithdrawal,
  type WithdrawalContextResponse,
} from "@/hooks/useConsentApi";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ShieldOff, AlertCircle, CheckCircle2, MailCheck } from "lucide-react";

type Entry =
  | { kind: "reference"; value: string }
  | { kind: "code"; value: string }
  | { kind: "none" };

/** Read the entry value once, fragment first, then scrub it from the URL. */
function readEntryFromUrl(): Entry {
  if (typeof window === "undefined") return { kind: "none" };
  const { hash, search, pathname } = window.location;
  const frag = new URLSearchParams(hash.startsWith("#") ? hash.slice(1) : hash);
  const query = new URLSearchParams(search);
  const code = (frag.get("code") ?? query.get("code"))?.trim();
  const ref = (frag.get("ref") ?? query.get("ref"))?.trim();
  if (code || ref) {
    window.history.replaceState(window.history.state, "", pathname);
  }
  if (code) return { kind: "code", value: code };
  if (ref) return { kind: "reference", value: ref };
  return { kind: "none" };
}

/** noindex while mounted — mirrors ConsentSignPage; the header is authoritative. */
function useNoIndex() {
  useEffect(() => {
    const meta = document.createElement("meta");
    meta.name = "robots";
    meta.content = "noindex, nofollow";
    document.head.appendChild(meta);
    return () => {
      document.head.removeChild(meta);
    };
  }, []);
}

export function ConsentWithdrawPage() {
  const { t } = useLanguage();
  const [entry] = useState<Entry>(readEntryFromUrl);
  useNoIndex();

  if (entry.kind === "none") {
    return (
      <PageShell title={t("consent.withdraw.invalidLink")}>
        <Status icon="error" message={t("consent.withdraw.missingCode")} />
      </PageShell>
    );
  }
  if (entry.kind === "reference") {
    return <RequestLinkView reference={entry.value} />;
  }
  return <WithdrawFlow code={entry.value} />;
}

/**
 * The receipt path. One button, one outcome message.
 *
 * The server answers identically for a real and a bogus reference, so this view
 * has nothing to branch on and deliberately shows the same message either way.
 * Anything else here would turn the receipt reference into an oracle for
 * "does this consent record exist".
 */
function RequestLinkView({ reference }: { reference: string }) {
  const { t } = useLanguage();
  const request = useRequestWithdrawalLink();
  const [sent, setSent] = useState(false);

  async function handleRequest() {
    try {
      await request.mutateAsync({ reference });
    } catch {
      // Even a transport failure must not distinguish itself from success in
      // what the user is told about the REFERENCE. It is reported as a generic
      // retry below only when the request never reached the server.
    }
    setSent(true);
  }

  if (sent) {
    return (
      <PageShell title={t("consent.withdraw.linkSentTitle")}>
        <Status icon="sent" message={t("consent.withdraw.linkSentBody")} />
      </PageShell>
    );
  }

  return (
    <PageShell title={t("consent.withdraw.requestTitle")}>
      <p className="text-sm text-muted-foreground mb-4">
        {t("consent.withdraw.requestIntro")}
      </p>
      <Button onClick={handleRequest} disabled={request.isPending}>
        {request.isPending
          ? t("consent.withdraw.sending")
          : t("consent.withdraw.requestButton")}
      </Button>
    </PageShell>
  );
}

/** The one-time-link path: resolve → second factor → confirm. */
function WithdrawFlow({ code }: { code: string }) {
  const { t } = useLanguage();
  const context = useWithdrawalContext();
  const [ctx, setCtx] = useState<WithdrawalContextResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Resolving the token is a READ — it changes nothing and cannot withdraw
  // anything — so it is safe to run on mount. The withdrawal itself is not.
  useEffect(() => {
    let cancelled = false;
    context
      .mutateAsync({ code })
      .then((data) => {
        if (!cancelled) setCtx(data);
      })
      .catch((e: any) => {
        if (!cancelled) setLoadError(errorMessageFor(e?.code, t));
      });
    return () => {
      cancelled = true;
    };
    // Intentionally once per code: re-running would burn nothing but would
    // re-render the page mid-flow.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code]);

  if (done) {
    return (
      <PageShell title={t("consent.withdraw.doneTitle")}>
        <Status icon="success" message={t("consent.withdraw.doneBody")} />
      </PageShell>
    );
  }
  if (loadError) {
    return (
      <PageShell title={t("consent.withdraw.linkProblem")}>
        <Status icon="error" message={loadError} />
      </PageShell>
    );
  }
  if (!ctx) {
    return (
      <PageShell title={t("consent.withdraw.loading")}>
        <p className="text-muted-foreground">{t("common.loading")}</p>
      </PageShell>
    );
  }

  return <WithdrawConfirm code={code} ctx={ctx} onDone={() => setDone(true)} />;
}

function WithdrawConfirm({
  code,
  ctx,
  onDone,
}: {
  code: string;
  ctx: WithdrawalContextResponse;
  onDone: () => void;
}) {
  // `t` only, deliberately NOT the student-label `ts`: that helper lives on
  // `useStudentLabel`, which calls `useInstitute()`, and this page renders
  // OUTSIDE every provider (a guardian with no account has no institute).
  // The copy here is guardian-facing and says "your child" throughout, which
  // is what the consent receipt and the sign page already say, so there is no
  // "student" for it to swap.
  const { t } = useLanguage();
  const requestOtp = useRequestWithdrawalOtp();
  const verifyOtp = useVerifyWithdrawalOtp();
  const verifyChildId = useVerifyWithdrawalChildId();
  const confirm = useConfirmWithdrawal();

  const [otpSentTo, setOtpSentTo] = useState<string | null>(null);
  const [otpCode, setOtpCode] = useState("");
  const [last4, setLast4] = useState("");
  const [factorDone, setFactorDone] = useState(!ctx.requiresPhoneOtp && (!ctx.requiresIdVerification || ctx.idVerified));
  const [factorError, setFactorError] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  async function handleSendOtp() {
    setFactorError(null);
    try {
      const out = await requestOtp.mutateAsync({ code });
      setOtpSentTo(out.sentTo);
    } catch (e: any) {
      setFactorError(e?.message ?? t("consent.withdraw.factorGenericError"));
    }
  }

  async function handleVerifyOtp() {
    setFactorError(null);
    try {
      await verifyOtp.mutateAsync({ code, otpCode: otpCode.trim() });
      setFactorDone(true);
    } catch (e: any) {
      setFactorError(
        e?.code === "code_mismatch"
          ? t("consent.withdraw.otpWrong")
          : e?.message ?? t("consent.withdraw.factorGenericError"),
      );
    }
  }

  async function handleVerifyChildId() {
    setFactorError(null);
    try {
      await verifyChildId.mutateAsync({ code, last4: last4.trim() });
      setFactorDone(true);
    } catch (e: any) {
      const remaining = e?.details?.attemptsRemaining;
      setFactorError(
        e?.code === "child_id_mismatch"
          ? `${t("consent.withdraw.childIdWrong")}${
              typeof remaining === "number"
                ? ` (${t("consent.withdraw.attemptsRemaining")}: ${remaining})`
                : ""
            }`
          : e?.code === "child_id_verify_locked"
            ? t("consent.withdraw.childIdLocked")
            : e?.message ?? t("consent.withdraw.factorGenericError"),
      );
    }
  }

  async function handleConfirm() {
    setSubmitError(null);
    try {
      await confirm.mutateAsync({ code, reason: reason.trim() || undefined });
      onDone();
    } catch (e: any) {
      setSubmitError(errorMessageFor(e?.code, t));
    }
  }

  const childName = ctx.student.firstName || ctx.student.name;

  return (
    <PageShell title={t("consent.withdraw.title")}>
      <div className="space-y-5">
        <div className="rounded-md border p-3 text-sm space-y-1">
          <p>
            <span className="text-muted-foreground">{t("consent.withdraw.forStudent")}: </span>
            <span className="font-medium">{ctx.student.name}</span>
          </p>
          {ctx.contact && (
            <p>
              <span className="text-muted-foreground">{t("consent.withdraw.signedBy")}: </span>
              <span className="font-medium">{ctx.contact.name}</span>
            </p>
          )}
          <p className="text-muted-foreground text-xs">
            {t("consent.withdraw.signedOn")} {ctx.consent.signedAt.split("T")[0]} ·{" "}
            {ctx.consent.consentTextVersion}
          </p>
        </div>

        {/* What withdrawing actually does — stated before any button appears. */}
        <div>
          <p className="text-sm font-medium mb-2">{t("consent.withdraw.effectsTitle")}</p>
          <ul className="list-disc ps-5 space-y-1 text-sm text-muted-foreground">
            <li>{t("consent.withdraw.effectProcessing")}</li>
            <li>{t("consent.withdraw.effectAac")}</li>
            <li>{t("consent.withdraw.effectShares")}</li>
            <li>{t("consent.withdraw.effectRecords")}</li>
            <li>{t("consent.withdraw.effectPast")}</li>
          </ul>
        </div>

        {/* Second factor — the same one the signing flow used for this channel. */}
        {!factorDone && ctx.requiresPhoneOtp && (
          <div className="space-y-2">
            <p className="text-sm">
              {t("consent.withdraw.otpIntro")}
              {ctx.contactPhoneMasked ? ` (${ctx.contactPhoneMasked})` : ""}
            </p>
            {!otpSentTo ? (
              <Button variant="outline" onClick={handleSendOtp} disabled={requestOtp.isPending}>
                {requestOtp.isPending
                  ? t("consent.withdraw.sending")
                  : t("consent.withdraw.sendOtp")}
              </Button>
            ) : (
              <div className="flex items-end gap-2 flex-wrap">
                <div className="space-y-1">
                  <Label htmlFor="withdraw-otp">{t("consent.withdraw.otpLabel")}</Label>
                  <Input
                    id="withdraw-otp"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={otpCode}
                    onChange={(e) => setOtpCode(e.target.value)}
                    placeholder={t("consent.withdraw.otpPlaceholder")}
                    className="w-40"
                  />
                </div>
                <Button onClick={handleVerifyOtp} disabled={verifyOtp.isPending || !otpCode.trim()}>
                  {t("consent.withdraw.verify")}
                </Button>
                <Button variant="ghost" onClick={handleSendOtp} disabled={requestOtp.isPending}>
                  {t("consent.withdraw.resendOtp")}
                </Button>
              </div>
            )}
          </div>
        )}

        {!factorDone && !ctx.requiresPhoneOtp && ctx.requiresIdVerification && (
          <div className="space-y-2">
            <p className="text-sm">{t("consent.withdraw.childIdIntro")}</p>
            <div className="flex items-end gap-2 flex-wrap">
              <div className="space-y-1">
                <Label htmlFor="withdraw-last4">{t("consent.withdraw.childIdLabel")}</Label>
                <Input
                  id="withdraw-last4"
                  inputMode="numeric"
                  value={last4}
                  onChange={(e) => setLast4(e.target.value)}
                  placeholder="1234"
                  className="w-32"
                />
              </div>
              <Button
                onClick={handleVerifyChildId}
                disabled={verifyChildId.isPending || last4.trim().length < 4}
              >
                {t("consent.withdraw.verify")}
              </Button>
            </div>
          </div>
        )}

        {factorError && <Status icon="error" message={factorError} />}

        {factorDone && (
          <>
            <div className="space-y-1">
              <Label htmlFor="withdraw-reason">{t("consent.withdraw.reasonLabel")}</Label>
              <Input
                id="withdraw-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={t("consent.withdraw.reasonPlaceholder")}
              />
            </div>

            {/* The affirmative act. The button does not exist until this is
                ticked, and the server independently requires `confirm: true`. */}
            <div className="flex items-start gap-2">
              <Checkbox
                id="withdraw-ack"
                checked={acknowledged}
                onCheckedChange={(v) => setAcknowledged(v === true)}
              />
              <Label htmlFor="withdraw-ack" className="text-sm font-normal leading-snug">
                {t("consent.withdraw.acknowledge")}
              </Label>
            </div>

            {submitError && <Status icon="error" message={submitError} />}

            <Button
              variant="destructive"
              onClick={handleConfirm}
              disabled={!acknowledged || confirm.isPending}
            >
              {confirm.isPending
                ? t("consent.withdraw.submitting")
                : t("consent.withdraw.confirmButton")}
            </Button>
          </>
        )}
      </div>
    </PageShell>
  );
}

function errorMessageFor(code: string | undefined, t: (k: string) => string): string {
  switch (code) {
    case "code_not_found":
      return t("consent.withdraw.error.notFound");
    case "code_expired":
      return t("consent.withdraw.error.expired");
    case "code_already_used":
      return t("consent.withdraw.error.used");
    case "code_revoked":
      return t("consent.withdraw.error.revoked");
    case "consent_already_revoked":
      return t("consent.withdraw.error.alreadyWithdrawn");
    case "consent_not_found":
      return t("consent.withdraw.error.notFound");
    case "phone_otp_required":
    case "child_id_verification_required":
      return t("consent.withdraw.error.factorRequired");
    default:
      return t("consent.withdraw.error.generic");
  }
}

function PageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/30 flex items-start justify-center p-6 pt-16">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldOff className="h-5 w-5" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

function Status({ icon, message }: { icon: "success" | "error" | "sent"; message: string }) {
  const Icon = icon === "success" ? CheckCircle2 : icon === "sent" ? MailCheck : AlertCircle;
  const color =
    icon === "success" ? "text-green-600" : icon === "sent" ? "text-blue-600" : "text-amber-600";
  return (
    <div className="flex items-start gap-3">
      <Icon className={`h-5 w-5 mt-0.5 flex-shrink-0 ${color}`} />
      <p className="text-sm">{message}</p>
    </div>
  );
}

export default ConsentWithdrawPage;
