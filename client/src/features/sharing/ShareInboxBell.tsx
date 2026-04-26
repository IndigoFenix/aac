// src/features/sharing/ShareInboxBell.tsx
//
// Header indicator for guardian-actionable share signals. Two signals roll up
// into one badge:
//   1. Pending share invites awaiting approval (`/api/shares/invites/inbox`)
//   2. Standing shares within the renewal window (`/api/shares/standing-shares/inbox`)
//
// The badge shows the total. When either signal grows (a new invite arrives,
// or a share crosses into the expiry window), a toast fires with copy specific
// to the kind of signal so the user knows whether to approve or to renew.
//
// Click navigates to /shares?tab=inbox — the Inbox tab is the unified surface
// for both signals.

import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useLocation } from "wouter";
import { Bell } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useToast } from "@/hooks/use-toast";
import { useLanguage } from "@/contexts/LanguageContext";
import { apiRequest } from "@/lib/queryClient";
import { useQuery } from "@tanstack/react-query";
import type {
  StudentShareInvite,
  StandingShareWithInvite,
} from "@/hooks/useSharesApi";

const POLL_INTERVAL_MS = 60_000;
const SHARES_INBOX_PATH = "/shares?tab=inbox";

/**
 * Window inside which standing shares trigger a notification. Shorter than the
 * 90-day visibility window in `StandingSharesList` (the panel surfaces shares
 * earlier so the guardian can plan; the bell only nags closer to expiry).
 * Already-expired shares are also counted — renewal still works on those.
 */
const EXPIRY_NOTIFICATION_THRESHOLD_DAYS = 30;

function isWithinNotificationWindow(share: StandingShareWithInvite["share"]): boolean {
  if (share.revokedAt) return false;
  const expiresAt = new Date(share.shareExpiresAt).getTime();
  const cutoff = Date.now() + EXPIRY_NOTIFICATION_THRESHOLD_DAYS * 24 * 60 * 60 * 1000;
  return expiresAt <= cutoff;
}

export function ShareInboxBell() {
  const { t } = useLanguage();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  const qc = useQueryClient();

  // Pending invites awaiting guardian approval.
  const { data: invitesData } = useQuery<{ invites: StudentShareInvite[] }>({
    queryKey: ["/api/shares/invites/inbox"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/shares/invites/inbox");
      return res.json();
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  // Standing shares the guardian holds — used to compute the expiry-window count.
  const { data: standingData } = useQuery<{ shares: StandingShareWithInvite[] }>({
    queryKey: ["/api/shares/standing-shares/inbox"],
    queryFn: async () => {
      const res = await apiRequest("GET", "/api/shares/standing-shares/inbox");
      return res.json();
    },
    refetchInterval: POLL_INTERVAL_MS,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  const inviteCount = (invitesData?.invites ?? []).length;
  const expiringCount = (standingData?.shares ?? [])
    .filter((r) => isWithinNotificationWindow(r.share))
    .length;
  const totalCount = inviteCount + expiringCount;

  // Two refs — separate per-signal so we can fire distinct toasts and avoid
  // muddling them. Initialized to null so first payload doesn't trigger a
  // toast for already-existing items (only newly-arrived signals notify).
  const prevInviteCountRef = useRef<number | null>(null);
  const prevExpiringCountRef = useRef<number | null>(null);

  useEffect(() => {
    if (invitesData === undefined) return;
    const prev = prevInviteCountRef.current;
    if (prev !== null && inviteCount > prev) {
      const delta = inviteCount - prev;
      toast({
        title: t("shares.notifications.newInviteTitle"),
        description: t("shares.notifications.newInviteBody", { count: delta }),
      });
    }
    prevInviteCountRef.current = inviteCount;
  }, [inviteCount, invitesData, t, toast]);

  useEffect(() => {
    if (standingData === undefined) return;
    const prev = prevExpiringCountRef.current;
    if (prev !== null && expiringCount > prev) {
      const delta = expiringCount - prev;
      toast({
        title: t("shares.notifications.expiringTitle"),
        description: t("shares.notifications.expiringBody", { count: delta }),
      });
    }
    prevExpiringCountRef.current = expiringCount;
  }, [expiringCount, standingData, t, toast]);

  if (totalCount === 0) {
    // Render the bell anyway as a stable affordance so the layout doesn't
    // shift when a signal arrives. Just no badge.
    return (
      <Button
        variant="ghost"
        size="icon"
        onClick={() => setLocation(SHARES_INBOX_PATH)}
        aria-label={t("shares.notifications.bellLabel")}
        data-testid="share-inbox-bell"
        className="hidden md:inline-flex"
      >
        <Bell className="w-4 h-4" />
      </Button>
    );
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => {
        setLocation(SHARES_INBOX_PATH);
        // Refresh on click so the inbox is fresh when the panel opens.
        qc.invalidateQueries({ queryKey: ["/api/shares/invites/inbox"] });
        qc.invalidateQueries({ queryKey: ["/api/shares/standing-shares/inbox"] });
      }}
      aria-label={t("shares.notifications.bellLabel")}
      data-testid="share-inbox-bell"
      className="hidden md:inline-flex relative"
    >
      <Bell className="w-4 h-4" />
      <Badge
        variant="destructive"
        className="absolute -top-1 -end-1 h-4 min-w-4 px-1 text-[10px] leading-none flex items-center justify-center"
      >
        {totalCount > 9 ? "9+" : totalCount}
      </Badge>
    </Button>
  );
}
