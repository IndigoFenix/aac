// src/components/admin/LicenseList.tsx
// List and manage licenses (admin)

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { useToast } from '@/hooks/use-toast';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  MoreHorizontal,
  Mail,
  HeadsetIcon,
  Gauge,
  Link2,
  Copy,
} from 'lucide-react';
import {
  useLicenses,
  useLicenseMutations,
  type AdminLicense,
} from '@/hooks/useAdminData';
import { LicenseForm } from './LicenseForm';
import { useLanguage } from '@/contexts/LanguageContext';
import { useAuth } from '@/hooks/useAuth';
import { apiRequest } from '@/lib/queryClient';
import { useLocation } from 'wouter';
import { computeLicenseStatus, licenseExpiryDate } from '@shared/license-status';

type StatusVariant = 'default' | 'secondary' | 'destructive' | 'outline';
type Translate = (key: string, params?: Record<string, string | number>) => string;

/**
 * The badge for one license row.
 *
 * Expiry comes from `computeLicenseStatus` — the SAME function the server
 * resolves permissions with — rather than a second copy of the rule here. A
 * local reimplementation would drift (it already has a grace period and a
 * "null expiry is perpetual" clause that are easy to forget), and a row shown
 * as Active while the server treats it as expired is the worst possible bug in
 * an admin console.
 *
 * The two states above it are NOT license-status states: suspension and a
 * never-accepted invite are operator/lifecycle facts that the status function
 * has no opinion about, so they are checked first.
 */
function getStatusInfo(license: AdminLicense, t: Translate): { label: string; variant: StatusVariant } {
  if (license.suspendedAt) return { label: t('admin.licenses.suspended'), variant: 'destructive' };
  if (!license.isActive) return { label: t('admin.licenses.inactive'), variant: 'secondary' };
  if (!license.userId && license.inviteEmail) {
    return { label: t('admin.licenses.pendingInvite'), variant: 'outline' };
  }
  const status = computeLicenseStatus(license);
  switch (status) {
    case 'expired':
      return { label: t('admin.licenses.expired'), variant: 'destructive' };
    case 'trial':
      return { label: t('admin.licenses.trial'), variant: 'secondary' };
    case 'none':
      return { label: t('admin.licenses.inactive'), variant: 'secondary' };
    default:
      return { label: t('admin.licenses.active'), variant: 'default' };
  }
}

/** Price in the ADMIN's UI locale, from minor units. Blank price = invoice
 *  customer, rendered as a dash rather than a zero. */
function formatPrice(license: AdminLicense, locale: string): string {
  if (license.priceAmount === null || license.priceAmount === undefined) return '—';
  const currency = license.priceCurrency || 'USD';
  try {
    return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(
      license.priceAmount / 100,
    );
  } catch {
    // An unknown/invalid ISO code makes Intl throw rather than fall back.
    return `${(license.priceAmount / 100).toFixed(2)} ${currency}`;
  }
}

function getPermissionsSummary(permissions: any): string {
  if (!permissions) return 'None';
  if (permissions.all) return 'All';
  const parts: string[] = [];
  if (permissions.aacEnabled) parts.push('AAC');
  if (permissions.boardMakerEnabled) parts.push('Boards');
  if (permissions.unrestrictedAI) parts.push('AI');
  if (permissions.calendar) parts.push('Calendar');
  if (permissions.maxStudents === -1) parts.push('Unlimited students');
  else if (permissions.maxStudents > 0) parts.push(`${permissions.maxStudents} students`);
  return parts.length > 0 ? parts.join(', ') : 'Minimal';
}

export function LicenseList() {
  const { toast } = useToast();
  const { t, language } = useLanguage();
  const [, navigate] = useLocation();
  const { user, refetchUser } = useAuth();
  const { data: licenses, isLoading, error } = useLicenses();
  const { deleteLicense, resendInvite, getInviteLink } = useLicenseMutations();

  const [editingLicense, setEditingLicense] = useState<AdminLicense | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [supportLoading, setSupportLoading] = useState<string | null>(null);
  const [linkLoading, setLinkLoading] = useState<string | null>(null);
  const [inviteLink, setInviteLink] = useState<{ url: string; expiresAt: string | null } | null>(null);

  const inSupportMode = !!user?.supportSession;

  const handleEdit = (license: AdminLicense) => {
    setEditingLicense(license);
    setIsFormOpen(true);
  };

  const handleCreate = () => {
    setEditingLicense(null);
    setIsFormOpen(true);
  };

  const handleFormClose = () => {
    setIsFormOpen(false);
    setEditingLicense(null);
  };

  const handleDelete = async () => {
    if (!deleteConfirmId) return;
    try {
      await deleteLicense.mutateAsync(deleteConfirmId);
      toast({ title: t('admin.licenses.deleted') });
      setDeleteConfirmId(null);
    } catch (err: any) {
      toast({
        title: t('common.error'),
        description: err.message || 'Failed to delete license',
        variant: 'destructive',
      });
    }
  };

  const handleResendInvite = async (id: string) => {
    try {
      await resendInvite.mutateAsync(id);
      toast({ title: t('admin.licenses.inviteResent') });
    } catch (err: any) {
      toast({
        title: t('common.error'),
        description: err.message || 'Failed to resend invite',
        variant: 'destructive',
      });
    }
  };

  /** Copy the invite ("verification") link so it can be delivered by hand when
   *  the invite email bounces. The dialog always shows the raw link too, so a
   *  clipboard rejection (Safari drops user activation across the fetch) still
   *  leaves the admin something to select. */
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast({ title: t('admin.licenses.inviteLinkCopied') });
    } catch {
      toast({ title: t('admin.licenses.inviteLinkCopyFailed'), variant: 'destructive' });
    }
  };

  const handleCopyInviteLink = async (id: string) => {
    setLinkLoading(id);
    try {
      const data = await getInviteLink.mutateAsync(id);
      setInviteLink({ url: data.inviteLink, expiresAt: data.expiresAt });
      await copyToClipboard(data.inviteLink);
    } catch (err: any) {
      toast({
        title: t('common.error'),
        description: err.message || 'Failed to get invite link',
        variant: 'destructive',
      });
    } finally {
      setLinkLoading(null);
    }
  };

  const handleSupportLogin = async (licenseId: string) => {
    setSupportLoading(licenseId);
    try {
      const res = await apiRequest('POST', '/api/admin/support-login', { licenseId });
      const data = await res.json();
      if (data.success) {
        toast({ title: `Entered support mode for ${data.institute?.name || 'institute'}` });
        await refetchUser();
        // Force page reload to reset all contexts (institutes, students, etc.)
        window.location.href = '/';
      } else {
        toast({ title: t('common.error'), description: data.message, variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: t('common.error'), description: err.message || 'Failed to enter support mode', variant: 'destructive' });
    } finally {
      setSupportLoading(null);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-64">
        <p className="text-destructive">Error loading licenses: {error.message}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">{t('admin.licenses.title')}</h1>
          <p className="text-muted-foreground">
            {t('admin.licenses.subtitle')}
          </p>
        </div>
        <Button onClick={handleCreate}>
          <Plus className="w-4 h-4 me-2" />
          {t('admin.licenses.createLicense')}
        </Button>
      </div>

      {/* Table */}
      {licenses && licenses.length > 0 ? (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('admin.licenses.licenseName')}</TableHead>
                <TableHead>{t('admin.licenses.owner')}</TableHead>
                <TableHead>{t('admin.licenses.type')}</TableHead>
                <TableHead>{t('admin.licenses.status')}</TableHead>
                <TableHead>{t('admin.licenses.price')}</TableHead>
                <TableHead>{t('admin.licenses.expires')}</TableHead>
                <TableHead>{t('admin.licenses.permissions')}</TableHead>
                <TableHead className="w-[70px]">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {licenses.map((license) => {
                const status = getStatusInfo(license, t);
                const expiry = licenseExpiryDate(license);
                const ownerDisplay = license.instituteName
                  ? license.instituteName
                  : license.userEmail || license.inviteEmail || '-';

                return (
                  <TableRow
                    key={license.id}
                    className="cursor-pointer"
                    onClick={() => navigate(`/admin/licenses/${license.id}/students`)}
                    data-testid={`row-license-${license.id}`}
                  >
                    <TableCell className="font-medium">
                      {license.name || '-'}
                    </TableCell>
                    <TableCell>
                      <div>
                        <span className="text-sm">{ownerDisplay}</span>
                        {/* When an institute is the owner, show the contact email
                            below it: the linked user's once registered, otherwise
                            the still-pending invite email. */}
                        {license.instituteName && (license.userEmail || license.inviteEmail) && (
                          <span className="block text-xs text-muted-foreground">{license.userEmail || license.inviteEmail}</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Badge variant="outline" className="capitalize">
                          {license.licenseType}
                        </Badge>
                        {license.isTrial && (
                          <Badge variant="secondary" className="text-amber-600">
                            {t('admin.licenses.trial')}
                          </Badge>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.variant}>{status.label}</Badge>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm whitespace-nowrap" dir="ltr">
                        {formatPrice(license, language)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-sm whitespace-nowrap text-muted-foreground">
                        {expiry
                          ? new Intl.DateTimeFormat(language, { dateStyle: 'medium' }).format(expiry)
                          : '—'}
                      </span>
                    </TableCell>
                    <TableCell>
                      <span className="text-xs text-muted-foreground">
                        {getPermissionsSummary(license.permissions)}
                      </span>
                    </TableCell>
                    <TableCell onClick={(e) => e.stopPropagation()}>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon" aria-label="More actions">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem onClick={() => navigate(`/admin/licenses/${license.id}/students`)}>
                            <Gauge className="w-4 h-4 me-2" />
                            {t('admin.budget.manageBudgets')}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => handleEdit(license)}>
                            <Pencil className="w-4 h-4 me-2" />
                            {t('common.edit')}
                          </DropdownMenuItem>
                          {license.inviteEmail && !license.userId && (
                            <DropdownMenuItem onClick={() => handleResendInvite(license.id)}>
                              <Mail className="w-4 h-4 me-2" />
                              {t('admin.licenses.resendInvite')}
                            </DropdownMenuItem>
                          )}
                          {license.inviteEmail && !license.userId && (
                            <DropdownMenuItem
                              disabled={linkLoading === license.id}
                              onClick={() => handleCopyInviteLink(license.id)}
                              data-testid={`button-copy-invite-link-${license.id}`}
                            >
                              {linkLoading === license.id
                                ? <Loader2 className="w-4 h-4 me-2 animate-spin" />
                                : <Link2 className="w-4 h-4 me-2" />}
                              {t('admin.licenses.copyInviteLink')}
                            </DropdownMenuItem>
                          )}
                          {license.instituteId && !inSupportMode && (
                            <DropdownMenuItem
                              disabled={supportLoading === license.id}
                              onClick={() => handleSupportLogin(license.id)}
                            >
                              {supportLoading === license.id
                                ? <Loader2 className="w-4 h-4 me-2 animate-spin" />
                                : <HeadsetIcon className="w-4 h-4 me-2" />}
                              {t('admin.support.login') || 'Login as Support'}
                            </DropdownMenuItem>
                          )}
                          <DropdownMenuItem
                            className="text-destructive"
                            onClick={() => setDeleteConfirmId(license.id)}
                          >
                            <Trash2 className="w-4 h-4 me-2" />
                            {t('common.delete')}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      ) : (
        <div className="flex flex-col items-center justify-center py-12 border rounded-md">
          <p className="text-muted-foreground mb-4">{t('admin.licenses.noLicenses')}</p>
          <Button onClick={handleCreate}>
            <Plus className="w-4 h-4 me-2" />
            {t('admin.licenses.createFirst')}
          </Button>
        </div>
      )}

      {/* Form Dialog */}
      <LicenseForm
        open={isFormOpen}
        onClose={handleFormClose}
        license={editingLicense}
      />

      {/* Invite link fallback — shown so the admin can select/forward the link
          manually when the invite email never arrived. */}
      <Dialog open={!!inviteLink} onOpenChange={(open) => !open && setInviteLink(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t('admin.licenses.inviteLinkTitle')}</DialogTitle>
            <DialogDescription>
              {t('admin.licenses.inviteLinkDescription')}
            </DialogDescription>
          </DialogHeader>
          <div className="rounded-md border bg-muted p-3">
            <code className="block text-xs break-all" dir="ltr" data-testid="text-invite-link">
              {inviteLink?.url}
            </code>
          </div>
          {inviteLink?.expiresAt && (
            <p className="text-xs text-muted-foreground">
              {t('admin.licenses.inviteLinkExpires')}{' '}
              {new Date(inviteLink.expiresAt).toLocaleDateString()}
            </p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={() => setInviteLink(null)}>
              {t('common.close')}
            </Button>
            <Button onClick={() => inviteLink && copyToClipboard(inviteLink.url)}>
              <Copy className="w-4 h-4 me-2" />
              {t('admin.licenses.copyInviteLink')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={!!deleteConfirmId} onOpenChange={() => setDeleteConfirmId(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.licenses.deleteLicense')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('admin.licenses.deleteConfirm')}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
