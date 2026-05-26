// client/src/pages/ConsentSignPage.tsx
//
// Public landing page for the magic-link consent flow. Reads ?code= from
// the URL, looks the invitation up via the public redeem endpoint, and
// renders the wizard in token-mode. No session required — the token IS
// the auth.
//
// See planning-docs/student-consent-onboarding-plan.md.

import { useEffect, useMemo, useState } from "react";
import { useSearch } from "wouter";

import { useLanguage } from "@/contexts/LanguageContext";
import { useConsentInvitation } from "@/hooks/useConsentApi";
import { ConsentWizard } from "@/features/consent/ConsentWizard";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ShieldCheck, AlertCircle, CheckCircle2 } from "lucide-react";

function useCodeFromQuery(): string | undefined {
  const search = useSearch();
  return useMemo(() => {
    const params = new URLSearchParams(search);
    const code = params.get("code");
    return code ? code.trim() : undefined;
  }, [search]);
}

/**
 * Inject a `noindex, nofollow` robots meta tag while this page is mounted.
 * The authoritative signal is the server's X-Robots-Tag header (see
 * server/routes.ts), but this guards client-rendered navigations and crawlers
 * that execute JS. Removed on unmount so the tag never leaks to other routes.
 */
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

export function ConsentSignPage() {
  const { t } = useLanguage();
  const code = useCodeFromQuery();
  const invitationQuery = useConsentInvitation(code);
  const [signed, setSigned] = useState(false);

  useNoIndex();

  // Open the wizard immediately once the invitation context resolves so the
  // parent doesn't see an empty page first.
  const [wizardOpen, setWizardOpen] = useState(false);
  useEffect(() => {
    if (invitationQuery.data && !signed) setWizardOpen(true);
  }, [invitationQuery.data, signed]);

  if (!code) {
    return (
      <PageShell title={t("consent.sign.invalidLink") || "Invalid link"}>
        <Status icon="error" message={t("consent.sign.missingCode") || "This link is missing the consent code. Please use the original link from the email or message you received."} />
      </PageShell>
    );
  }

  // `signed` wins over everything else: once we know the user successfully
  // submitted, the inevitable code_already_used error from a stale refetch
  // should not flip the page back to "couldn't open this link".
  if (signed) {
    return (
      <PageShell title={t("consent.sign.thankYouTitle") || "Thank you"}>
        <Status
          icon="success"
          message={t("consent.sign.thankYouBody") || "Your informed consent has been recorded. The clinic now has authorization to manage your child's records as described."}
        />
      </PageShell>
    );
  }

  if (invitationQuery.isLoading) {
    return (
      <PageShell title={t("consent.sign.loading") || "Loading"}>
        <p className="text-muted-foreground">{t("common.loading") || "Loading..."}</p>
      </PageShell>
    );
  }

  if (invitationQuery.error) {
    const errCode = (invitationQuery.error as any).code as string | undefined;
    const message = errorMessageFor(errCode, t);
    return (
      <PageShell title={t("consent.sign.linkProblem") || "We couldn't open this consent link"}>
        <Status icon="error" message={message} />
      </PageShell>
    );
  }

  return (
    <PageShell title={t("consent.sign.title") || "Informed consent"}>
      <p className="text-muted-foreground mb-4">
        {t("consent.sign.intro") || "You've been asked to review and sign an informed-consent record for your child. Click below to read the notice and complete the form."}
      </p>
      <Button onClick={() => setWizardOpen(true)}>
        {t("consent.sign.openWizard") || "Open consent wizard"}
      </Button>
      {wizardOpen && (
        <ConsentWizard
          tokenCode={code}
          onSuccess={() => setSigned(true)}
          onClose={() => setWizardOpen(false)}
        />
      )}
    </PageShell>
  );
}

function errorMessageFor(code: string | undefined, t: (k: string) => string): string {
  switch (code) {
    case "code_not_found":
      return t("consent.sign.error.notFound") || "This link is no longer valid. Ask the clinic to resend it.";
    case "code_expired":
      return t("consent.sign.error.expired") || "This link has expired. Ask the clinic to send a new one.";
    case "code_already_used":
      return t("consent.sign.error.used") || "This consent has already been signed. Thank you.";
    case "code_revoked":
      return t("consent.sign.error.revoked") || "This link was cancelled by the clinic. Contact them if you have questions.";
    default:
      return t("consent.sign.error.generic") || "Something went wrong opening this consent link. Please try again or contact the clinic.";
  }
}

function PageShell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-muted/30 flex items-start justify-center p-6 pt-16">
      <Card className="w-full max-w-2xl">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <ShieldCheck className="h-5 w-5" />
            {title}
          </CardTitle>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  );
}

function Status({ icon, message }: { icon: "success" | "error"; message: string }) {
  const Icon = icon === "success" ? CheckCircle2 : AlertCircle;
  const color = icon === "success" ? "text-green-600" : "text-amber-600";
  return (
    <div className="flex items-start gap-3">
      <Icon className={`h-5 w-5 mt-0.5 flex-shrink-0 ${color}`} />
      <p className="text-sm">{message}</p>
    </div>
  );
}

export default ConsentSignPage;
