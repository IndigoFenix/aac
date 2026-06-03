// client/src/features/consent/SendConsentRequestDialog.tsx
//
// Clinician dialog for sending a magic-link consent request to a parent.
// Pick an existing contact, choose channel (email / sms / copy-link), submit.
// On success: shows the redemption URL with a copy button + dispatch confirmation.
//
// See planning-docs/student-consent-onboarding-plan.md.

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import { useCreateConsentInvitation, useConsentAuthority } from "@/hooks/useConsentApi";
import { useFeaturePanel } from "@/contexts/FeaturePanelContext";
import { openUI } from "@/lib/uiEvents";

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
import { Copy, Mail, Send, MessageSquare, UserPlus } from "lucide-react";

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
  const { setActiveFeature } = useFeaturePanel();

  // Jump to the Contacts panel and pop the create-contact modal blank — used
  // when there's no parent contact to send to yet, or the user needs to add
  // another. Unlike the consent-wizard "Add me as contact" path, this does
  // NOT prefill any user-specific fields.
  function handleAddContact() {
    onClose();
    setActiveFeature('contacts');
    // Defer until the contacts panel mounts and registers its listener.
    setTimeout(() => openUI('createContact'), 0);
  }

  // Pull contacts for this student.
  const contactsQuery = useQuery<{ success: boolean; contacts: ContactRow[] }>({
    queryKey: ["/api/biometric/students", studentId, "contacts"],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/biometric/students/${studentId}/contacts`);
      return res.json();
    },
  });

  const contacts = contactsQuery.data?.contacts ?? [];

  // Resolve who may sign — for a self-consenting (adult) student the request is
  // addressed to the student themselves, not a guardian contact.
  const authorityQuery = useConsentAuthority(studentId);
  const resolvedSigner = authorityQuery.data?.resolved?.signerType ?? null;

  const [contactId, setContactId] = useState<string>("");
  const [recipientType, setRecipientType] = useState<"guardian" | "self">("guardian");
  const [selfDestination, setSelfDestination] = useState<string>("");
  const [channel, setChannel] = useState<"email" | "sms" | "manual">("email");

  // Default the recipient to the resolved signer once known.
  useEffect(() => {
    if (resolvedSigner) setRecipientType(resolvedSigner);
  }, [resolvedSigner]);

  const isSelf = recipientType === "self";

  const selectedContact = useMemo(
    () => contacts.find((c) => c.id === contactId),
    [contacts, contactId],
  );

  // The available channels depend on the destination. For a guardian it's which
  // fields the contact has; for self it's whether a destination was entered.
  const channelAvailable = useMemo(() => {
    if (isSelf) {
      const has = selfDestination.trim().length > 0;
      return { email: has, sms: has, manual: true };
    }
    return {
      email: !!selectedContact?.contactEmail,
      sms: !!selectedContact?.contactPhone,
      manual: true,
    };
  }, [isSelf, selfDestination, selectedContact]);

  const [result, setResult] = useState<{
    code: string;
    redemptionUrl: string;
    expiresAt: string;
  } | null>(null);

  async function handleSubmit() {
    if (!isSelf && !contactId) return;
    if (isSelf && channel !== "manual" && !selfDestination.trim()) return;
    try {
      const r = await create.mutateAsync({
        studentId,
        sourceInstituteId,
        channel,
        ...(isSelf
          ? { recipientType: "self" as const, selfDestination: selfDestination.trim() }
          : { recipientType: "guardian" as const, contactId }),
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
              recipientType={recipientType}
              setRecipientType={setRecipientType}
              selfDestination={selfDestination}
              setSelfDestination={setSelfDestination}
              channel={channel}
              setChannel={setChannel}
              channelAvailable={channelAvailable}
              onAddContact={handleAddContact}
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
                  (isSelf ? (channel !== "manual" && !selfDestination.trim()) : !contactId) ||
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
  recipientType,
  setRecipientType,
  selfDestination,
  setSelfDestination,
  channel,
  setChannel,
  channelAvailable,
  onAddContact,
  t,
}: {
  contacts: ContactRow[];
  isLoading: boolean;
  contactId: string;
  setContactId: (v: string) => void;
  recipientType: "guardian" | "self";
  setRecipientType: (v: "guardian" | "self") => void;
  selfDestination: string;
  setSelfDestination: (v: string) => void;
  channel: "email" | "sms" | "manual";
  setChannel: (v: "email" | "sms" | "manual") => void;
  channelAvailable: { email: boolean; sms: boolean; manual: boolean };
  onAddContact: () => void;
  t: (k: string) => string;
}) {
  if (isLoading) {
    return <p className="text-muted-foreground">{t("common.loading") || "Loading..."}</p>;
  }
  const isSelf = recipientType === "self";
  // For a guardian request we need contacts to exist; the self path doesn't.
  if (!isSelf && contacts.length === 0) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-2 gap-2">
          <RecipientOption
            label={t("consent.authority.recipientGuardian") || "A parent / guardian"}
            selected={!isSelf}
            onClick={() => setRecipientType("guardian")}
          />
          <RecipientOption
            label={t("consent.authority.recipientSelf") || "The student"}
            selected={isSelf}
            onClick={() => setRecipientType("self")}
          />
        </div>
        <p className="text-sm text-muted-foreground">
          {t("consent.send.noContacts") ||
            "No contacts on file for this student. Add a parent contact in the Contacts tab first."}
        </p>
        <Button onClick={onAddContact}>
          <UserPlus className="h-4 w-4 me-2" />
          {t("consent.send.addContact") || "Add a contact"}
        </Button>
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <div>
        <Label>{t("consent.authority.recipientLabel") || "Who signs"}</Label>
        <div className="grid grid-cols-2 gap-2 mt-1">
          <RecipientOption
            label={t("consent.authority.recipientGuardian") || "A parent / guardian"}
            selected={!isSelf}
            onClick={() => setRecipientType("guardian")}
          />
          <RecipientOption
            label={t("consent.authority.recipientSelf") || "The student"}
            selected={isSelf}
            onClick={() => setRecipientType("self")}
          />
        </div>
      </div>

      {isSelf ? (
        <div>
          <Label>{t("consent.authority.selfDestinationLabel") || "Student email or phone"}</Label>
          <Input
            value={selfDestination}
            onChange={(e) => setSelfDestination(e.target.value)}
            placeholder={t("consent.authority.selfDestinationPlaceholder") || "student@example.com or +972…"}
            className="mt-1"
          />
          <p className="text-xs text-muted-foreground mt-1">
            {t("consent.authority.selfDestinationHint") ||
              "An SMS code is the strongest verification for sensitive data."}
          </p>
        </div>
      ) : (
      <div>
        <div className="flex items-center justify-between">
          <Label>{t("consent.send.contactLabel") || "Send to"}</Label>
          <Button variant="link" size="sm" onClick={onAddContact} className="h-auto p-0">
            <UserPlus className="h-3 w-3 me-1" />
            {t("consent.send.addContact") || "Add a contact"}
          </Button>
        </div>
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
      )}

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

function RecipientOption({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md border p-3 text-sm transition-colors ${
        selected ? "border-primary bg-primary/10" : "border-border hover:bg-muted/50"
      }`}
    >
      {label}
    </button>
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
          <Button variant="outline" size="icon" onClick={onCopy} aria-label="Copy link">
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
