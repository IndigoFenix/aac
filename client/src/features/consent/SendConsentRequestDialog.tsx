// client/src/features/consent/SendConsentRequestDialog.tsx
//
// Clinician dialog for sending a magic-link consent request to a parent.
// Pick an existing contact, choose channel (email / sms / copy-link), submit.
// On success: shows the redemption URL with a copy button + dispatch confirmation.
//
// See planning-docs/student-consent-onboarding-plan.md.

import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { useCreateConsentInvitation } from "@/hooks/useConsentApi";

import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Copy, Mail, Send, MessageSquare } from "lucide-react";

interface SendConsentRequestDialogProps {
  studentId: string;
  sourceInstituteId: string;
  onClose: () => void;
}

interface ContactRow {
  id: string;
  name: string;
  relationship?: string | null;
  contactEmail?: string | null;
  contactPhone?: string | null;
  linkedUserId?: string | null;
}

export function SendConsentRequestDialog({
  studentId,
  sourceInstituteId,
  onClose,
}: SendConsentRequestDialogProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const create = useCreateConsentInvitation();

  // Pull contacts for this student.
  const contactsQuery = useQuery<{ success: boolean; contacts: ContactRow[] }>({
    queryKey: ["/api/biometric/students", studentId, "contacts"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/biometric/students/${studentId}/contacts`);
      return res.json();
    },
  });

  const contacts = contactsQuery.data?.contacts ?? [];

  const [contactId, setContactId] = useState<string>("");
  const [channel, setChannel] = useState<"email" | "sms" | "manual">("email");

  const selectedContact = useMemo(
    () => contacts.find((c) => c.id === contactId),
    [contacts, contactId],
  );

  // The available channels depend on which fields the selected contact has.
  // If the contact has neither email nor phone, only "manual" is offered.
  const channelAvailable = useMemo(() => {
    return {
      email: !!selectedContact?.contactEmail,
      sms: !!selectedContact?.contactPhone,
      manual: true,
    };
  }, [selectedContact]);

  const [result, setResult] = useState<{
    code: string;
    redemptionUrl: string;
    expiresAt: string;
  } | null>(null);

  async function handleSubmit() {
    if (!contactId) return;
    try {
      const r = await create.mutateAsync({
        studentId,
        contactId,
        sourceInstituteId,
        channel,
      });
      setResult({
        code: r.code,
        redemptionUrl: r.redemptionUrl,
        expiresAt: r.invitation.expiresAt,
      });
      toast({
        title: t("consent.send.toastSentTitle") || "Consent request sent",
        description:
          channel === "manual"
            ? t("consent.send.toastSentManual") || "Copy the link below and share it with the parent."
            : channel === "email"
            ? t("consent.send.toastSentEmail") || "An email was sent to the parent."
            : t("consent.send.toastSentSms") || "An SMS was sent to the parent.",
      });
    } catch (e: any) {
      toast({
        title: t("consent.send.toastErrorTitle") || "Couldn't send consent request",
        description: e?.message ?? "Unknown error",
        variant: "destructive",
      });
    }
  }

  function copyLink() {
    if (!result) return;
    navigator.clipboard.writeText(result.redemptionUrl);
    toast({
      title: t("consent.send.toastLinkCopied") || "Link copied",
    });
  }

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="h-5 w-5" />
            {t("consent.send.title") || "Send consent request to parent"}
          </DialogTitle>
          <DialogDescription>
            {t("consent.send.description") ||
              "Pick the parent contact and choose how to deliver the link. The parent will sign consent without needing an account."}
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          {result ? (
            <ResultPanel result={result} channel={channel} onCopy={copyLink} t={t} />
          ) : (
            <FormPanel
              contacts={contacts}
              isLoading={contactsQuery.isLoading}
              contactId={contactId}
              setContactId={setContactId}
              channel={channel}
              setChannel={setChannel}
              channelAvailable={channelAvailable}
              t={t}
            />
          )}
        </DialogBody>

        <DialogFooter>
          {result ? (
            <Button onClick={onClose}>{t("common.close") || "Close"}</Button>
          ) : (
            <>
              <Button variant="outline" onClick={onClose}>
                {t("common.cancel") || "Cancel"}
              </Button>
              <Button
                onClick={handleSubmit}
                disabled={
                  !contactId ||
                  !channelAvailable[channel] ||
                  create.isPending
                }
              >
                {create.isPending
                  ? t("common.saving") || "Saving..."
                  : t("consent.send.submit") || "Send"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function FormPanel({
  contacts,
  isLoading,
  contactId,
  setContactId,
  channel,
  setChannel,
  channelAvailable,
  t,
}: {
  contacts: ContactRow[];
  isLoading: boolean;
  contactId: string;
  setContactId: (v: string) => void;
  channel: "email" | "sms" | "manual";
  setChannel: (v: "email" | "sms" | "manual") => void;
  channelAvailable: { email: boolean; sms: boolean; manual: boolean };
  t: (k: string) => string;
}) {
  if (isLoading) {
    return <p className="text-muted-foreground">{t("common.loading") || "Loading..."}</p>;
  }
  if (contacts.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        {t("consent.send.noContacts") ||
          "No contacts on file for this student. Add a parent contact in the Contacts tab first."}
      </p>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <Label>{t("consent.send.contactLabel") || "Send to"}</Label>
        <Select value={contactId} onValueChange={setContactId}>
          <SelectTrigger>
            <SelectValue placeholder={t("consent.send.contactPlaceholder") || "Pick a parent contact"} />
          </SelectTrigger>
          <SelectContent>
            {contacts.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                <div className="flex flex-col">
                  <span>{c.name}</span>
                  <span className="text-xs text-muted-foreground">
                    {[c.relationship, c.contactEmail, c.contactPhone].filter(Boolean).join(" · ")}
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label>{t("consent.send.channelLabel") || "Delivery channel"}</Label>
        <div className="grid grid-cols-3 gap-2 mt-1">
          <ChannelOption
            id="email"
            label={t("consent.send.channel.email") || "Email"}
            icon={<Mail className="h-4 w-4" />}
            selected={channel === "email"}
            disabled={!channelAvailable.email}
            onClick={() => setChannel("email")}
          />
          <ChannelOption
            id="sms"
            label={t("consent.send.channel.sms") || "SMS"}
            icon={<MessageSquare className="h-4 w-4" />}
            selected={channel === "sms"}
            disabled={!channelAvailable.sms}
            onClick={() => setChannel("sms")}
          />
          <ChannelOption
            id="manual"
            label={t("consent.send.channel.manual") || "Copy link"}
            icon={<Copy className="h-4 w-4" />}
            selected={channel === "manual"}
            disabled={false}
            onClick={() => setChannel("manual")}
          />
        </div>
        {channel !== "manual" && !channelAvailable[channel] && (
          <p className="text-xs text-destructive mt-2">
            {t("consent.send.channelUnavailable") ||
              "This contact has no value for the chosen channel. Pick a different one or use Copy link."}
          </p>
        )}
      </div>
    </div>
  );
}

function ChannelOption({
  label,
  icon,
  selected,
  disabled,
  onClick,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  selected: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={`flex items-center justify-center gap-2 rounded-md border p-3 text-sm transition-colors ${
        selected
          ? "border-primary bg-primary/10"
          : "border-border hover:bg-muted/50"
      } ${disabled ? "opacity-40 cursor-not-allowed" : "cursor-pointer"}`}
    >
      {icon}
      {label}
    </button>
  );
}

function ResultPanel({
  result,
  channel,
  onCopy,
  t,
}: {
  result: { code: string; redemptionUrl: string; expiresAt: string };
  channel: "email" | "sms" | "manual";
  onCopy: () => void;
  t: (k: string) => string;
}) {
  return (
    <div className="space-y-4">
      <p className="text-sm">
        {channel === "manual"
          ? t("consent.send.resultManual") || "Copy this link and share it with the parent. It can only be used once."
          : t("consent.send.resultDispatched") || "We sent the consent link. The parent has until the expiry date to sign."}
      </p>
      <div className="space-y-2">
        <Label>{t("consent.send.resultLinkLabel") || "Redemption link"}</Label>
        <div className="flex items-center gap-2">
          <Input value={result.redemptionUrl} readOnly className="text-xs" />
          <Button variant="outline" size="icon" onClick={onCopy}>
            <Copy className="h-4 w-4" />
          </Button>
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {(t("consent.send.resultExpiresAt") || "Expires on")}: {result.expiresAt.split("T")[0]}
      </p>
    </div>
  );
}

export default SendConsentRequestDialog;
