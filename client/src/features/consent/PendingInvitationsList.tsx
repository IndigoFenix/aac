// client/src/features/consent/PendingInvitationsList.tsx
//
// Inline list of in-flight consent invitations for a student. Surfaces what
// the clinician has sent and lets them revoke. Renders nothing when there
// are no pending invitations.

import { formatDistanceToNow } from "date-fns";
import { useLanguage } from "@/contexts/LanguageContext";
import { useToast } from "@/hooks/use-toast";
import {
  usePendingInvitations,
  useRevokeConsentInvitation,
  type PendingInvitation,
} from "@/hooks/useConsentApi";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Mail, MessageSquare, Copy, Send, X } from "lucide-react";

interface PendingInvitationsListProps {
  studentId: string;
}

export function PendingInvitationsList({ studentId }: PendingInvitationsListProps) {
  const { t } = useLanguage();
  const { toast } = useToast();
  const query = usePendingInvitations(studentId);
  const revoke = useRevokeConsentInvitation();

  if (query.isLoading) return null;
  const invitations = query.data?.invitations ?? [];
  if (invitations.length === 0) return null;

  async function handleRevoke(id: string) {
    try {
      await revoke.mutateAsync({ invitationId: id, studentId });
      toast({ title: t("consent.pending.toastRevoked") || "Invitation revoked" });
    } catch (e: any) {
      toast({
        title: t("consent.pending.toastRevokeFailed") || "Could not revoke",
        description: e?.message ?? "Unknown error",
        variant: "destructive",
      });
    }
  }

  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
        {t("consent.pending.header") || "Pending consent requests"}
      </p>
      {invitations.map((inv) => (
        <InvitationRow key={inv.id} invitation={inv} onRevoke={() => handleRevoke(inv.id)} />
      ))}
    </div>
  );
}

function InvitationRow({ invitation, onRevoke }: { invitation: PendingInvitation; onRevoke: () => void }) {
  const { t } = useLanguage();
  const expiresAt = new Date(invitation.expiresAt);
  const expiresIn = formatDistanceToNow(expiresAt, { addSuffix: true });
  const Icon = channelIcon(invitation.channel);
  return (
    <div className="flex items-center gap-3 rounded-md border p-3 bg-muted/20">
      <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-sm truncate">
          {invitation.channel === "manual"
            ? t("consent.pending.manualLabel") || "Copy-link invitation"
            : invitation.sentTo}
        </p>
        <p className="text-xs text-muted-foreground">
          {(t("consent.pending.expiresLabel") || "Expires")} {expiresIn}
        </p>
      </div>
      <Badge variant="secondary" className="capitalize">
        {invitation.channel}
      </Badge>
      <Button variant="ghost" size="sm" onClick={onRevoke} title={t("consent.pending.revokeAction") || "Revoke"}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}

function channelIcon(channel: PendingInvitation["channel"]) {
  switch (channel) {
    case "email": return Mail;
    case "sms": return MessageSquare;
    case "manual": return Copy;
    default: return Send;
  }
}
