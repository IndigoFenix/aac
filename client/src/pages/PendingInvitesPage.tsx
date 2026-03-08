// src/pages/PendingInvitesPage.tsx
// Page for viewing and responding to pending institute invites

import { useState } from 'react';
import { useLocation } from 'wouter';
import { useInstitute, PendingInvite } from '@/hooks/useInstitute';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useToast } from '@/hooks/use-toast';
import { cn } from '@/lib/utils';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
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
import {
  Building2,
  School,
  Hospital,
  Check,
  X,
  Clock,
  ArrowLeft,
  Mail,
  Loader2,
  Crown,
} from 'lucide-react';

export default function PendingInvitesPage() {
  const { t, isRTL, language } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const { pendingInvites, acceptInvite, declineInvite, refetchPendingInvites } = useInstitute();

  const [processingId, setProcessingId] = useState<string | null>(null);
  const [declineConfirmId, setDeclineConfirmId] = useState<string | null>(null);

  const handleAccept = async (inviteId: string) => {
    setProcessingId(inviteId);
    try {
      await acceptInvite(inviteId);
      toast({
        title: t('invite.accepted') || 'Invite Accepted',
        description: t('invite.acceptedDesc') || 'You have joined the institute.',
      });
      refetchPendingInvites();
    } catch (error: any) {
      toast({
        title: t('invite.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setProcessingId(null);
    }
  };

  const handleDecline = async () => {
    if (!declineConfirmId) return;
    
    setProcessingId(declineConfirmId);
    try {
      await declineInvite(declineConfirmId);
      toast({
        title: t('invite.declined') || 'Invite Declined',
      });
      refetchPendingInvites();
    } catch (error: any) {
      toast({
        title: t('invite.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setProcessingId(null);
      setDeclineConfirmId(null);
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString(language === 'he' ? 'he-IL' : 'en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const isExpiringSoon = (expiresAt: string) => {
    const expiry = new Date(expiresAt);
    const now = new Date();
    const daysUntilExpiry = (expiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return daysUntilExpiry <= 2;
  };

  return (
    <div 
      dir={isRTL ? 'rtl' : 'ltr'}
      className={cn(
        'min-h-screen',
        isDark ? 'bg-slate-950' : 'bg-gray-50'
      )}
    >
      {/* Header */}
      <div className={cn(
        'border-b sticky top-0 z-10',
        isDark ? 'border-slate-800 bg-slate-900' : 'border-gray-200 bg-white'
      )}>
        <div className="max-w-3xl mx-auto px-4 py-4">
          <div className="flex items-center gap-4">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setLocation('/home')}
            >
              <ArrowLeft className="w-4 h-4 me-2" />
              {t('common.back') || 'Back'}
            </Button>
            <div>
              <h1 className={cn(
                'text-xl font-bold',
                isDark ? 'text-white' : 'text-slate-900'
              )}>
                {t('invite.pendingInvites') || 'Pending Invites'}
              </h1>
              <p className="text-sm text-muted-foreground">
                {t('invite.pendingInvitesDesc') || 'Review and respond to institute invitations'}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-3xl mx-auto px-4 py-6">
        {pendingInvites.length === 0 ? (
          <Card className={cn(
            isDark ? 'bg-slate-900 border-slate-800' : ''
          )}>
            <CardContent className="py-12 text-center">
              <Mail className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
              <h3 className="text-lg font-medium mb-2">
                {t('invite.noInvites') || 'No Pending Invites'}
              </h3>
              <p className="text-sm text-muted-foreground mb-4">
                {t('invite.noInvitesDesc') || "You don't have any pending institute invitations."}
              </p>
              <Button onClick={() => setLocation('/home')}>
                {t('common.back') || 'Go Back'}
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {pendingInvites.map((invite) => (
              <Card
                key={invite.id}
                className={cn(
                  'overflow-hidden',
                  isDark ? 'bg-slate-900 border-slate-800' : ''
                )}
              >
                <CardContent className="p-0">
                  <div className="flex flex-col sm:flex-row">
                    {/* Institute Info */}
                    <div className={cn(
                      'flex-1 p-4 flex items-start gap-4',
                      isDark ? 'border-slate-800' : 'border-gray-200'
                    )}>
                      <div className={cn(
                        'w-12 h-12 rounded-lg flex items-center justify-center shrink-0',
                        isDark ? 'bg-slate-800' : 'bg-secondary'
                      )}>
                        {invite.institute.type === 'hospital' ? (
                          <Hospital className="w-6 h-6 text-primary" />
                        ) : (
                          <School className="w-6 h-6 text-primary" />
                        )}
                      </div>
                      <div className="flex-1 min-w-0">
                        <h3 className="font-semibold text-base truncate">
                          {invite.institute.name}
                        </h3>
                        <p className="text-sm text-muted-foreground mb-2">
                          {t(`institute.type.${invite.institute.type}`) || invite.institute.type}
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="secondary">{invite.role}</Badge>
                          {invite.grantAdmin && (
                            <Badge variant="outline" className="gap-1">
                              <Crown className="w-3 h-3" />
                              {t('invite.admin') || 'Admin'}
                            </Badge>
                          )}
                        </div>
                        {invite.invitedBy && (
                          <p className="text-xs text-muted-foreground mt-2">
                            {t('invite.from') || 'From'}: {invite.invitedBy.fullName || invite.invitedBy.email}
                          </p>
                        )}
                        {invite.message && (
                          <div className={cn(
                            'mt-3 p-2 rounded text-sm italic',
                            isDark ? 'bg-slate-800' : 'bg-muted'
                          )}>
                            "{invite.message}"
                          </div>
                        )}
                      </div>
                    </div>

                    {/* Actions */}
                    <div className={cn(
                      'p-4 flex flex-row sm:flex-col items-center justify-end gap-2 border-t sm:border-t-0 sm:border-s',
                      isDark ? 'border-slate-800 bg-slate-800/50' : 'border-gray-200 bg-gray-50'
                    )}>
                      <div className="text-xs text-muted-foreground mb-2 hidden sm:block">
                        <div className="flex items-center gap-1">
                          <Clock className="w-3 h-3" />
                          {t('invite.expires') || 'Expires'}:
                        </div>
                        <span className={cn(
                          isExpiringSoon(invite.expiresAt) && 'text-amber-500 font-medium'
                        )}>
                          {formatDate(invite.expiresAt)}
                        </span>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => handleAccept(invite.id)}
                        disabled={processingId === invite.id}
                        className="gap-1"
                      >
                        {processingId === invite.id ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          <Check className="w-4 h-4" />
                        )}
                        {t('invite.accept') || 'Accept'}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setDeclineConfirmId(invite.id)}
                        disabled={processingId === invite.id}
                        className="gap-1"
                      >
                        <X className="w-4 h-4" />
                        {t('invite.decline') || 'Decline'}
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>

      {/* Decline Confirmation */}
      <AlertDialog open={!!declineConfirmId} onOpenChange={(open) => !open && setDeclineConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('invite.confirmDecline') || 'Decline Invite?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('invite.confirmDeclineDesc') || 'Are you sure you want to decline this invitation? You can request a new invite later.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel') || 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction onClick={handleDecline}>
              {processingId && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('invite.decline') || 'Decline'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
