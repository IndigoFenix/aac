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
  Plus,
  Pencil,
  Trash2,
  Loader2,
  MoreHorizontal,
  Mail,
  HeadsetIcon,
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

function getStatusInfo(license: AdminLicense): { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } {
  if (license.suspendedAt) return { label: 'Suspended', variant: 'destructive' };
  if (!license.isActive) return { label: 'Inactive', variant: 'secondary' };
  if (!license.userId && license.inviteEmail) return { label: 'Pending Invite', variant: 'outline' };
  if (license.activatedAt) return { label: 'Active', variant: 'default' };
  return { label: 'Active', variant: 'default' };
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
  const { t } = useLanguage();
  const { user, refetchUser } = useAuth();
  const { data: licenses, isLoading, error } = useLicenses();
  const { deleteLicense, resendInvite } = useLicenseMutations();

  const [editingLicense, setEditingLicense] = useState<AdminLicense | null>(null);
  const [isFormOpen, setIsFormOpen] = useState(false);
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [supportLoading, setSupportLoading] = useState<string | null>(null);

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
                <TableHead>{t('admin.licenses.permissions')}</TableHead>
                <TableHead className="w-[70px]">{t('common.actions')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {licenses.map((license) => {
                const status = getStatusInfo(license);
                const ownerDisplay = license.instituteName
                  ? license.instituteName
                  : license.userEmail || license.inviteEmail || '-';

                return (
                  <TableRow key={license.id}>
                    <TableCell className="font-medium">
                      {license.name || '-'}
                    </TableCell>
                    <TableCell>
                      <div>
                        <span className="text-sm">{ownerDisplay}</span>
                        {license.instituteName && license.userEmail && (
                          <span className="block text-xs text-muted-foreground">{license.userEmail}</span>
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
                      <span className="text-xs text-muted-foreground">
                        {getPermissionsSummary(license.permissions)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button variant="ghost" size="icon">
                            <MoreHorizontal className="w-4 h-4" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
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
