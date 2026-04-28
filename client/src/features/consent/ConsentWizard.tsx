// client/src/features/consent/ConsentWizard.tsx
//
// Family-flow consent wizard. Walks the parent through:
//   1. Confirm student + signing parent identity (read from wizard-context)
//   2. Declare guardianship + co-guardian + government-ID
//   3. Read the informed-consent notice + ack the three required disclosures
//   4. Set opt-ins
//   5. Submit (signs consent + flips contact.isLegalGuardian = true)
//
// Lives in the clinician client only. v1 uses authenticated_session as the
// IDV method; stronger flows (clinic in-person, video, gov SSO, third-party
// IDV) will be separate components.
//
// See planning-docs/student-consent-onboarding-plan.md.

import { useEffect, useMemo, useState } from "react";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  useConsentNotice,
  useConsentWizardContext,
  useSignConsent,
  useConsentInvitation,
  useSignWithToken,
  useRequestPhoneOtp,
  useVerifyPhoneOtp,
  type ConsentNoticeResponse,
  type WizardContextResponse,
  type ConsentInvitationContextResponse,
} from "@/hooks/useConsentApi";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ShieldCheck, FileText, AlertCircle, CheckCircle2 } from "lucide-react";

interface ConsentWizardProps {
  /**
   * Session-auth mode: the parent is logged in. Pass the studentId they want
   * to sign for; the wizard fetches context via /wizard-context.
   */
  studentId?: string;
  /**
   * Token-auth mode: the parent arrived via a magic link without a session.
   * Pass the invitation code; the wizard resolves the (student, contact) via
   * /invitations/redeem and signs via /invitations/sign.
   */
  tokenCode?: string;
  /** Called when the wizard finishes successfully or the user closes it. */
  onClose: () => void;
  /** Called only after a successful sign — fires before onClose. */
  onSuccess?: () => void;
}

type Step = "identity" | "phoneOtp" | "guardian" | "notice" | "optIns" | "review";

const STEP_ORDER_BASE: Step[] = ["identity", "guardian", "notice", "optIns", "review"];
const STEP_ORDER_WITH_OTP: Step[] = ["identity", "phoneOtp", "guardian", "notice", "optIns", "review"];

export function ConsentWizard({ studentId, tokenCode, onClose, onSuccess }: ConsentWizardProps) {
  const { t, language } = useLanguage();
  const { toast } = useToast();

  // Mode resolution: token mode uses the public invitation hooks; session
  // mode uses the authenticated wizard-context hook. Either path produces
  // the same wizard-context shape via mergeContext below.
  const isTokenMode = !!tokenCode;
  const sessionCtxQuery = useConsentWizardContext(isTokenMode ? undefined : studentId);
  const tokenCtxQuery = useConsentInvitation(tokenCode);

  const ctx: WizardContextResponse | undefined = isTokenMode
    ? mergeInvitationContext(tokenCtxQuery.data)
    : sessionCtxQuery.data;
  const ctxIsLoading = isTokenMode ? tokenCtxQuery.isLoading : sessionCtxQuery.isLoading;
  const ctxError = isTokenMode ? tokenCtxQuery.error : sessionCtxQuery.error;

  // Notice locale: prefer the student's UI language; the server falls back
  // to en when the locale isn't translated yet.
  const country = (ctx?.student.country ?? "IL").toUpperCase();
  const noticeQuery = useConsentNotice(country, language);
  const notice = noticeQuery.data;

  const [step, setStep] = useState<Step>("identity");

  // Guardian declaration form state — seeded from the wizard context.
  const [coGuardianAck, setCoGuardianAck] = useState(false);
  const [govIdNumber, setGovIdNumber] = useState("");
  const [govIdType, setGovIdType] = useState<"national_id" | "passport" | "driver_license" | "other">("national_id");
  const [govIdCountry, setGovIdCountry] = useState(country);

  // Required disclosures (Section 11).
  const [purposeAck, setPurposeAck] = useState(false);
  const [voluntarinessAck, setVoluntarinessAck] = useState(false);
  const [transfersAck, setTransfersAck] = useState(false);

  // Opt-ins — default off.
  const [optTraining, setOptTraining] = useState(false);
  const [optAdvertising, setOptAdvertising] = useState(false);
  const [optResearch, setOptResearch] = useState(false);
  const [optMarketing, setOptMarketing] = useState(false);

  // Seed from existing contact data when ctx loads.
  useEffect(() => {
    const c = ctx?.guardianContact;
    if (!c) return;
    if (c.governmentIdNumber) setGovIdNumber(c.governmentIdNumber);
    if (c.governmentIdType) setGovIdType(c.governmentIdType as any);
    if (c.governmentIdCountry) setGovIdCountry(c.governmentIdCountry);
    if (c.coGuardianAcknowledged) setCoGuardianAck(true);
  }, [ctx?.guardianContact]);

  const sessionSign = useSignConsent(studentId ?? "");
  const tokenSign = useSignWithToken();
  const signPending = isTokenMode ? tokenSign.isPending : sessionSign.isPending;

  // OTP step is shown when the invitation arrived via SMS — that's the
  // PPA-required non-repudiation leg. Only relevant in token mode.
  const requiresPhoneOtp = isTokenMode && (tokenCtxQuery.data?.requiresPhoneOtp ?? false);
  const phoneMasked = isTokenMode ? tokenCtxQuery.data?.contactPhoneMasked ?? null : null;
  const STEP_ORDER = requiresPhoneOtp ? STEP_ORDER_WITH_OTP : STEP_ORDER_BASE;

  const [phoneOtpVerified, setPhoneOtpVerified] = useState(false);

  const canProceedFromGuardian = govIdNumber.trim().length >= 4 && coGuardianAck;
  const canProceedFromNotice = purposeAck && voluntarinessAck && transfersAck;
  const canProceedFromPhoneOtp = !requiresPhoneOtp || phoneOtpVerified;

  const stepIndex = STEP_ORDER.indexOf(step);
  const progress = `${stepIndex + 1} / ${STEP_ORDER.length}`;

  function gotoNext() {
    const i = STEP_ORDER.indexOf(step);
    if (i < STEP_ORDER.length - 1) setStep(STEP_ORDER[i + 1]);
  }
  function gotoPrev() {
    const i = STEP_ORDER.indexOf(step);
    if (i > 0) setStep(STEP_ORDER[i - 1]);
  }

  async function handleSubmit() {
    if (!ctx?.guardianContact || !notice) return;
    const guardianFields = {
      coGuardianAcknowledged: coGuardianAck,
      governmentIdNumber: govIdNumber.trim(),
      governmentIdType: govIdType,
      governmentIdCountry: govIdCountry.toUpperCase(),
    };
    const acks = {
      purposeAcknowledged: purposeAck,
      voluntarinessAcknowledged: voluntarinessAck,
      thirdPartyTransfersAcknowledged: transfersAck,
      optInModelTraining: optTraining,
      optInAdvertising: optAdvertising,
      optInThirdPartyResearch: optResearch,
      optInMarketingComms: optMarketing,
      isSensitive: false as const,
    };
    try {
      if (isTokenMode && tokenCode) {
        await tokenSign.mutateAsync({
          code: tokenCode,
          locale: notice.locale,
          consentTextVersion: notice.version,
          consentTextHash: notice.hash,
          guardianFields,
          ...acks,
        });
      } else {
        await sessionSign.mutateAsync({
          signedByContactId: ctx.guardianContact.id,
          locale: notice.locale,
          consentTextVersion: notice.version,
          consentTextHash: notice.hash,
          guardianFields,
          ...acks,
        });
      }
      toast({
        title: t("consent.wizard.toastSignedTitle"),
        description: t("consent.wizard.toastSignedDescription"),
      });
      onSuccess?.();
      onClose();
    } catch (e: any) {
      toast({
        title: t("consent.wizard.toastErrorTitle"),
        description: e?.message ?? "Unknown error",
        variant: "destructive",
      });
    }
  }

  // ---------------- render ----------------

  if (ctxIsLoading || noticeQuery.isLoading) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("consent.wizard.title")}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <p className="text-muted-foreground">{t("common.loading")}</p>
          </DialogBody>
        </DialogContent>
      </Dialog>
    );
  }

  if (!ctx?.guardianContact) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("consent.wizard.title")}</DialogTitle>
            <DialogDescription>{t("consent.wizard.noGuardianContact")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={onClose}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  if (!notice) {
    return (
      <Dialog open onOpenChange={(o) => !o && onClose()}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("consent.wizard.title")}</DialogTitle>
            <DialogDescription>{t("consent.wizard.noNoticeForCountry")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button onClick={onClose}>{t("common.close")}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            {t("consent.wizard.title")}
          </DialogTitle>
          <DialogDescription>
            {t("consent.wizard.stepLabel")} {progress}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {step === "identity" && (
            <IdentityStep ctx={ctx} />
          )}
          {step === "phoneOtp" && tokenCode && (
            <PhoneOtpStep
              code={tokenCode}
              phoneMasked={phoneMasked}
              verified={phoneOtpVerified}
              onVerified={() => setPhoneOtpVerified(true)}
            />
          )}
          {step === "guardian" && (
            <GuardianStep
              govIdNumber={govIdNumber}
              setGovIdNumber={setGovIdNumber}
              govIdType={govIdType}
              setGovIdType={setGovIdType}
              govIdCountry={govIdCountry}
              setGovIdCountry={setGovIdCountry}
              coGuardianAck={coGuardianAck}
              setCoGuardianAck={setCoGuardianAck}
            />
          )}
          {step === "notice" && (
            <NoticeStep
              notice={notice}
              purposeAck={purposeAck}
              setPurposeAck={setPurposeAck}
              voluntarinessAck={voluntarinessAck}
              setVoluntarinessAck={setVoluntarinessAck}
              transfersAck={transfersAck}
              setTransfersAck={setTransfersAck}
            />
          )}
          {step === "optIns" && (
            <OptInsStep
              optTraining={optTraining}
              setOptTraining={setOptTraining}
              optAdvertising={optAdvertising}
              setOptAdvertising={setOptAdvertising}
              optResearch={optResearch}
              setOptResearch={setOptResearch}
              optMarketing={optMarketing}
              setOptMarketing={setOptMarketing}
            />
          )}
          {step === "review" && (
            <ReviewStep
              ctx={ctx}
              notice={notice}
              coGuardianAck={coGuardianAck}
              govIdNumber={govIdNumber}
              govIdType={govIdType}
              govIdCountry={govIdCountry}
              optTraining={optTraining}
              optAdvertising={optAdvertising}
              optResearch={optResearch}
              optMarketing={optMarketing}
            />
          )}
        </DialogBody>

        <DialogFooter className="flex justify-between">
          <Button variant="outline" onClick={gotoPrev} disabled={stepIndex === 0}>
            {t("common.back")}
          </Button>
          {step !== "review" ? (
            <Button
              onClick={gotoNext}
              disabled={
                (step === "phoneOtp" && !canProceedFromPhoneOtp) ||
                (step === "guardian" && !canProceedFromGuardian) ||
                (step === "notice" && !canProceedFromNotice)
              }
            >
              {t("common.next")}
            </Button>
          ) : (
            <Button onClick={handleSubmit} disabled={signPending}>
              {signPending ? t("common.saving") : t("consent.wizard.signButton")}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ============================================================================
// Steps
// ============================================================================

function IdentityStep({ ctx }: { ctx: WizardContextResponse }) {
  const { t } = useLanguage();
  const userName = ctx.user?.fullName ?? [ctx.user?.firstName, ctx.user?.lastName].filter(Boolean).join(" ");
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">{t("consent.wizard.identityIntro")}</p>
      <div className="rounded-md border p-3 space-y-2">
        <div className="flex justify-between">
          <span className="text-sm text-muted-foreground">{t("consent.wizard.studentLabel")}</span>
          <span className="text-sm font-medium">{ctx.student.name}</span>
        </div>
        {ctx.student.birthDate && (
          <div className="flex justify-between">
            <span className="text-sm text-muted-foreground">{t("consent.wizard.birthDateLabel")}</span>
            <span className="text-sm">{ctx.student.birthDate}</span>
          </div>
        )}
        <div className="flex justify-between">
          <span className="text-sm text-muted-foreground">{t("consent.wizard.countryLabel")}</span>
          <span className="text-sm">{ctx.student.country ?? "IL"}</span>
        </div>
      </div>
      <div className="rounded-md border p-3 space-y-2">
        <div className="flex justify-between">
          <span className="text-sm text-muted-foreground">{t("consent.wizard.signingAsLabel")}</span>
          <span className="text-sm font-medium">{userName}</span>
        </div>
        {ctx.user?.email && (
          <div className="flex justify-between">
            <span className="text-sm text-muted-foreground">{t("consent.wizard.emailLabel")}</span>
            <span className="text-sm">{ctx.user.email}</span>
          </div>
        )}
      </div>
    </div>
  );
}

interface PhoneOtpStepProps {
  code: string;
  phoneMasked: string | null;
  verified: boolean;
  onVerified: () => void;
}

function PhoneOtpStep({ code, phoneMasked, verified, onVerified }: PhoneOtpStepProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const requestOtp = useRequestPhoneOtp();
  const verifyOtp = useVerifyPhoneOtp();
  const [otpInput, setOtpInput] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [bypass, setBypass] = useState(false);

  async function handleSend() {
    try {
      const out = await requestOtp.mutateAsync({ code });
      setSentTo(out.sentTo);
      setBypass(out.bypass);
      toast({
        title: t("consent.wizard.phoneOtp.sentToastTitle") || "Code sent",
        description: out.bypass
          ? (t("consent.wizard.phoneOtp.sentBypassToastDesc") || "Bypass mode active — enter 000000")
          : (t("consent.wizard.phoneOtp.sentToastDesc") || `Code sent to ${out.sentTo}`),
      });
    } catch (e: any) {
      toast({
        title: t("consent.wizard.phoneOtp.sendErrorTitle") || "Couldn't send code",
        description: e?.message ?? "Unknown error",
        variant: "destructive",
      });
    }
  }

  async function handleVerify() {
    try {
      await verifyOtp.mutateAsync({ code, otpCode: otpInput.trim() });
      onVerified();
      toast({
        title: t("consent.wizard.phoneOtp.verifiedToastTitle") || "Phone verified",
      });
    } catch (e: any) {
      toast({
        title: t("consent.wizard.phoneOtp.verifyErrorTitle") || "Verification failed",
        description: e?.message ?? "Unknown error",
        variant: "destructive",
      });
    }
  }

  if (verified) {
    return (
      <div className="space-y-3">
        <div className="rounded-md border p-3 flex items-start gap-2">
          <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-600" />
          <div className="text-sm">
            {(t("consent.wizard.phoneOtp.verifiedBody") || "Phone verified — you can continue.")}
          </div>
        </div>
        {(sentTo || phoneMasked) && (
          <p className="text-xs text-muted-foreground">{sentTo ?? phoneMasked}</p>
        )}
      </div>
    );
  }

  const showInput = !!sentTo || requestOtp.isSuccess;
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">
        {(t("consent.wizard.phoneOtp.intro") || "We need to verify your phone before you sign. We'll send a code by SMS to your number on file.")}
      </p>
      {phoneMasked && (
        <p className="text-sm">
          <span className="text-muted-foreground">
            {(t("consent.wizard.phoneOtp.phoneLabel") || "Phone")}:
          </span>
          <span className="font-medium">{phoneMasked}</span>
        </p>
      )}
      {!showInput && (
        <Button onClick={handleSend} disabled={requestOtp.isPending}>
          {requestOtp.isPending
            ? (t("common.sending") || "Sending...")
            : (t("consent.wizard.phoneOtp.sendButton") || "Send code")}
        </Button>
      )}
      {showInput && (
        <div className="space-y-3">
          {bypass && (
            <div className="rounded-md border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800">
              {t("consent.wizard.phoneOtp.bypassNotice") || "Bypass mode is active — use code 000000."}
            </div>
          )}
          <div>
            <Label htmlFor="otp-input">
              {t("consent.wizard.phoneOtp.codeLabel") || "Verification code"}
            </Label>
            <Input
              id="otp-input"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={otpInput}
              onChange={(e) => setOtpInput(e.target.value.replace(/\D/g, ""))}
              placeholder="000000"
            />
          </div>
          <div className="flex gap-2">
            <Button
              onClick={handleVerify}
              disabled={otpInput.length < 6 || verifyOtp.isPending}
            >
              {verifyOtp.isPending
                ? (t("common.verifying") || "Verifying...")
                : (t("consent.wizard.phoneOtp.verifyButton") || "Verify")}
            </Button>
            <Button
              variant="outline"
              onClick={handleSend}
              disabled={requestOtp.isPending}
            >
              {t("consent.wizard.phoneOtp.resendButton") || "Resend"}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

interface GuardianStepProps {
  govIdNumber: string;
  setGovIdNumber: (v: string) => void;
  govIdType: "national_id" | "passport" | "driver_license" | "other";
  setGovIdType: (v: "national_id" | "passport" | "driver_license" | "other") => void;
  govIdCountry: string;
  setGovIdCountry: (v: string) => void;
  coGuardianAck: boolean;
  setCoGuardianAck: (v: boolean) => void;
}

function GuardianStep(p: GuardianStepProps) {
  const { t } = useLanguage();
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">{t("consent.wizard.guardianIntro")}</p>
      <div className="space-y-3">
        <div>
          <Label htmlFor="gov-id-type">{t("consent.wizard.govIdTypeLabel")}</Label>
          <Select value={p.govIdType} onValueChange={(v) => p.setGovIdType(v as any)}>
            <SelectTrigger id="gov-id-type">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="national_id">{t("consent.wizard.govIdType.national_id")}</SelectItem>
              <SelectItem value="passport">{t("consent.wizard.govIdType.passport")}</SelectItem>
              <SelectItem value="driver_license">{t("consent.wizard.govIdType.driver_license")}</SelectItem>
              <SelectItem value="other">{t("consent.wizard.govIdType.other")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="gov-id-country">{t("consent.wizard.govIdCountryLabel")}</Label>
          <Input
            id="gov-id-country"
            value={p.govIdCountry}
            maxLength={2}
            onChange={(e) => p.setGovIdCountry(e.target.value.toUpperCase())}
            placeholder="IL"
          />
        </div>
        <div>
          <Label htmlFor="gov-id-number">{t("consent.wizard.govIdNumberLabel")}</Label>
          <Input
            id="gov-id-number"
            value={p.govIdNumber}
            onChange={(e) => p.setGovIdNumber(e.target.value)}
            placeholder={t("consent.wizard.govIdNumberPlaceholder")}
          />
        </div>
      </div>
      <div className="flex items-start gap-2 rounded-md border p-3">
        <Checkbox
          id="co-guardian-ack"
          checked={p.coGuardianAck}
          onCheckedChange={(v) => p.setCoGuardianAck(v === true)}
          className="mt-1"
        />
        <Label htmlFor="co-guardian-ack" className="cursor-pointer text-sm leading-relaxed">
          {t("consent.wizard.coGuardianDeclaration")}
        </Label>
      </div>
    </div>
  );
}

interface NoticeStepProps {
  notice: ConsentNoticeResponse;
  purposeAck: boolean;
  setPurposeAck: (v: boolean) => void;
  voluntarinessAck: boolean;
  setVoluntarinessAck: (v: boolean) => void;
  transfersAck: boolean;
  setTransfersAck: (v: boolean) => void;
}

function NoticeStep(p: NoticeStepProps) {
  const { t } = useLanguage();
  const c = p.notice.content;
  return (
    <div className="space-y-3">
      <ScrollArea className="h-72 rounded-md border p-3">
        <h3 className="font-semibold mb-2 flex items-center gap-2">
          <FileText className="h-4 w-4" />
          {c.title}
        </h3>
        <Section title={t("consent.notice.purposeHeader")} body={c.purposeStatement} />
        <Section title={t("consent.notice.voluntarinessHeader")} body={c.voluntarinessStatement} />
        <Section title={t("consent.notice.recipientsHeader")} body={c.thirdPartyTransfersStatement} />
        <ul className="text-sm space-y-1 mt-1 mb-3 list-disc pl-5">
          {p.notice.thirdPartyRecipients.map((r, i) => (
            <li key={i}>
              <span className="font-medium">{r.name}</span>
              <span className="text-muted-foreground"> — {r.purpose}</span>
            </li>
          ))}
        </ul>
        <Section title={t("consent.notice.retentionHeader")} body={c.retentionStatement} />
        <Section title={t("consent.notice.rightsHeader")} body={c.rightsStatement} />
      </ScrollArea>
      <p className="text-xs text-muted-foreground">
        {t("consent.notice.versionLabel")}: {p.notice.version}
      </p>

      <div className="space-y-2">
        <AckRow
          id="ack-purpose"
          checked={p.purposeAck}
          onChange={p.setPurposeAck}
          label={t("consent.wizard.ackPurpose")}
        />
        <AckRow
          id="ack-voluntariness"
          checked={p.voluntarinessAck}
          onChange={p.setVoluntarinessAck}
          label={t("consent.wizard.ackVoluntariness")}
        />
        <AckRow
          id="ack-transfers"
          checked={p.transfersAck}
          onChange={p.setTransfersAck}
          label={t("consent.wizard.ackTransfers")}
        />
      </div>
    </div>
  );
}

function Section({ title, body }: { title: string; body: string }) {
  return (
    <div className="mb-3">
      <h4 className="text-sm font-semibold">{title}</h4>
      <p className="text-sm text-muted-foreground">{body}</p>
    </div>
  );
}

function AckRow({ id, checked, onChange, label }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <div className="flex items-start gap-2 rounded-md border p-3">
      <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} className="mt-1" />
      <Label htmlFor={id} className="cursor-pointer text-sm leading-relaxed">{label}</Label>
    </div>
  );
}

interface OptInsStepProps {
  optTraining: boolean; setOptTraining: (v: boolean) => void;
  optAdvertising: boolean; setOptAdvertising: (v: boolean) => void;
  optResearch: boolean; setOptResearch: (v: boolean) => void;
  optMarketing: boolean; setOptMarketing: (v: boolean) => void;
}

function OptInsStep(p: OptInsStepProps) {
  const { t } = useLanguage();
  return (
    <div className="space-y-4">
      <p className="text-muted-foreground">{t("consent.wizard.optInsIntro")}</p>
      <OptInRow id="opt-training" checked={p.optTraining} onChange={p.setOptTraining}
        label={t("consent.wizard.optInTrainingLabel")}
        desc={t("consent.wizard.optInTrainingDesc")} />
      <OptInRow id="opt-advertising" checked={p.optAdvertising} onChange={p.setOptAdvertising}
        label={t("consent.wizard.optInAdvertisingLabel")}
        desc={t("consent.wizard.optInAdvertisingDesc")} />
      <OptInRow id="opt-research" checked={p.optResearch} onChange={p.setOptResearch}
        label={t("consent.wizard.optInResearchLabel")}
        desc={t("consent.wizard.optInResearchDesc")} />
      <OptInRow id="opt-marketing" checked={p.optMarketing} onChange={p.setOptMarketing}
        label={t("consent.wizard.optInMarketingLabel")}
        desc={t("consent.wizard.optInMarketingDesc")} />
    </div>
  );
}

function OptInRow({ id, checked, onChange, label, desc }: { id: string; checked: boolean; onChange: (v: boolean) => void; label: string; desc: string }) {
  return (
    <div className="flex items-start justify-between rounded-md border p-3 gap-3">
      <div className="flex-1">
        <Label htmlFor={id} className="text-sm font-medium cursor-pointer">{label}</Label>
        <p className="text-xs text-muted-foreground mt-0.5">{desc}</p>
      </div>
      <Switch id={id} checked={checked} onCheckedChange={onChange} />
    </div>
  );
}

interface ReviewStepProps {
  ctx: WizardContextResponse;
  notice: ConsentNoticeResponse;
  coGuardianAck: boolean;
  govIdNumber: string;
  govIdType: string;
  govIdCountry: string;
  optTraining: boolean;
  optAdvertising: boolean;
  optResearch: boolean;
  optMarketing: boolean;
}

function ReviewStep(p: ReviewStepProps) {
  const { t } = useLanguage();
  const optsOn = useMemo(
    () => [
      p.optTraining ? t("consent.wizard.optInTrainingLabel") : null,
      p.optAdvertising ? t("consent.wizard.optInAdvertisingLabel") : null,
      p.optResearch ? t("consent.wizard.optInResearchLabel") : null,
      p.optMarketing ? t("consent.wizard.optInMarketingLabel") : null,
    ].filter(Boolean) as string[],
    [p.optTraining, p.optAdvertising, p.optResearch, p.optMarketing, t],
  );
  return (
    <div className="space-y-3">
      <div className="rounded-md border p-3 flex items-start gap-2">
        <CheckCircle2 className="h-4 w-4 mt-0.5 text-green-600" />
        <div className="text-sm">
          {t("consent.wizard.reviewIntro")}
        </div>
      </div>
      <div className="rounded-md border p-3 space-y-2 text-sm">
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("consent.wizard.studentLabel")}</span>
          <span>{p.ctx.student.name}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("consent.wizard.govIdLabel")}</span>
          <span>{p.govIdType} ({p.govIdCountry}) ···{p.govIdNumber.slice(-4)}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("consent.wizard.coGuardianLabel")}</span>
          <span>{p.coGuardianAck ? t("common.yes") : t("common.no")}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("consent.wizard.noticeLabel")}</span>
          <span>{p.notice.version}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-muted-foreground">{t("consent.wizard.optInsLabel")}</span>
          <span>{optsOn.length > 0 ? optsOn.join(", ") : t("consent.wizard.optInsNoneOn")}</span>
        </div>
      </div>
      <div className="rounded-md border bg-muted/40 p-3 flex items-start gap-2">
        <AlertCircle className="h-4 w-4 mt-0.5 text-muted-foreground" />
        <p className="text-xs text-muted-foreground">{t("consent.wizard.reviewWarning")}</p>
      </div>
    </div>
  );
}

/**
 * Adapter — collapses the token-mode invitation context into the same shape
 * the wizard already consumes (WizardContextResponse). The token flow has
 * no logged-in user, so `user` is null; the contact is the one resolved
 * from the token.
 */
function mergeInvitationContext(
  data: ConsentInvitationContextResponse | undefined,
): WizardContextResponse | undefined {
  if (!data) return undefined;
  return {
    success: true,
    student: data.student,
    user: null,
    guardianContact: {
      id: data.contact.id,
      studentId: data.student.id,
      name: data.contact.name,
      linkedUserId: null,
      governmentIdNumber: data.contact.governmentIdNumber,
      governmentIdType: data.contact.governmentIdType,
      governmentIdCountry: data.contact.governmentIdCountry,
      isLegalGuardian: data.contact.isLegalGuardian,
      coGuardianAcknowledged: data.contact.coGuardianAcknowledged,
    },
    activeConsent: null,
  };
}
