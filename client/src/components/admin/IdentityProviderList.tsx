import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Plus,
  Pencil,
  Trash2,
  Loader2,
  ShieldCheck,
} from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';
import { useLanguage } from '@/contexts/LanguageContext';

interface IdentityProvider {
  id: string;
  name: string;
  protocol: 'oidc' | 'oauth2';
  discoveryUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  clientId: string;
  scopes?: string;
  claimMappings?: Record<string, unknown>;
  instituteIdType?: string;
  reverificationDays?: number;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

const QUERY_KEY = ['/api/admin/identity-providers'];

const emptyForm = {
  name: '',
  protocol: 'oidc' as 'oidc' | 'oauth2',
  discoveryUrl: '',
  authorizationUrl: '',
  tokenUrl: '',
  userinfoUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid email profile',
  instituteIdType: '',
  reverificationDays: '',
  isActive: true,
};

export function IdentityProviderList() {
  const { toast } = useToast();
  const { t } = useLanguage();
  const queryClient = useQueryClient();

  const [isFormOpen, setIsFormOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [form, setForm] = useState(emptyForm);

  const { data, isLoading } = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/admin/identity-providers');
      const json = await res.json();
      return json.providers as IdentityProvider[];
    },
  });

  const providers = data ?? [];

  const saveMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        name: form.name,
        protocol: form.protocol,
        clientId: form.clientId,
        scopes: form.scopes || 'openid email profile',
        instituteIdType: form.instituteIdType || null,
        reverificationDays: form.reverificationDays ? parseInt(form.reverificationDays) : null,
        isActive: form.isActive,
      };
      if (form.clientSecret) body.clientSecret = form.clientSecret;
      if (form.protocol === 'oidc') {
        body.discoveryUrl = form.discoveryUrl || null;
      } else {
        body.authorizationUrl = form.authorizationUrl || null;
        body.tokenUrl = form.tokenUrl || null;
        body.userinfoUrl = form.userinfoUrl || null;
      }

      if (editingId) {
        await apiRequest('PATCH', `/api/admin/identity-providers/${editingId}`, body);
      } else {
        if (!form.clientSecret) throw new Error('Client secret is required');
        body.clientSecret = form.clientSecret;
        await apiRequest('POST', '/api/admin/identity-providers', body);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setIsFormOpen(false);
      setEditingId(null);
      setForm(emptyForm);
      toast({ title: editingId ? t('admin.identityProviders.updated') : t('admin.identityProviders.created') });
    },
    onError: (err: any) => {
      toast({ title: t('common.error'), description: err.message, variant: 'destructive' });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await apiRequest('DELETE', `/api/admin/identity-providers/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: QUERY_KEY });
      setDeleteId(null);
      toast({ title: t('admin.identityProviders.deleted') });
    },
    onError: (err: any) => {
      toast({ title: t('common.error'), description: err.message, variant: 'destructive' });
    },
  });

  const openCreate = () => {
    setEditingId(null);
    setForm(emptyForm);
    setIsFormOpen(true);
  };

  const openEdit = (provider: IdentityProvider) => {
    setEditingId(provider.id);
    setForm({
      name: provider.name,
      protocol: provider.protocol,
      discoveryUrl: provider.discoveryUrl || '',
      authorizationUrl: provider.authorizationUrl || '',
      tokenUrl: provider.tokenUrl || '',
      userinfoUrl: provider.userinfoUrl || '',
      clientId: provider.clientId,
      clientSecret: '', // never sent back from server
      scopes: provider.scopes || 'openid email profile',
      instituteIdType: provider.instituteIdType || '',
      reverificationDays: provider.reverificationDays?.toString() || '',
      isActive: provider.isActive,
    });
    setIsFormOpen(true);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="w-6 h-6 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-2xl font-bold flex items-center gap-2">
            <ShieldCheck className="w-6 h-6" />
            {t('admin.identityProviders.title')}
          </h2>
          <p className="text-muted-foreground text-sm">
            {t('admin.identityProviders.description')}
          </p>
        </div>
        <Button onClick={openCreate}>
          <Plus className="w-4 h-4 me-2" />
          {t('admin.identityProviders.add')}
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('common.name')}</TableHead>
            <TableHead>{t('admin.identityProviders.protocol')}</TableHead>
            <TableHead>{t('admin.identityProviders.instituteType')}</TableHead>
            <TableHead>{t('admin.identityProviders.reverification')}</TableHead>
            <TableHead>{t('common.status')}</TableHead>
            <TableHead className="w-20" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {providers.length === 0 && (
            <TableRow>
              <TableCell colSpan={6} className="text-center text-muted-foreground py-8">
                {t('admin.identityProviders.empty')}
              </TableCell>
            </TableRow>
          )}
          {providers.map((p) => (
            <TableRow key={p.id}>
              <TableCell className="font-medium">{p.name}</TableCell>
              <TableCell>
                <Badge variant="outline">{p.protocol.toUpperCase()}</Badge>
              </TableCell>
              <TableCell>{p.instituteIdType || '-'}</TableCell>
              <TableCell>
                {p.reverificationDays
                  ? t('admin.identityProviders.days', { count: p.reverificationDays.toString() })
                  : t('admin.identityProviders.never')}
              </TableCell>
              <TableCell>
                <Badge variant={p.isActive ? 'default' : 'secondary'}>
                  {p.isActive ? t('common.active') : t('common.inactive')}
                </Badge>
              </TableCell>
              <TableCell>
                <div className="flex gap-1">
                  <Button variant="ghost" size="icon" onClick={() => openEdit(p)}>
                    <Pencil className="w-4 h-4" />
                  </Button>
                  <Button variant="ghost" size="icon" onClick={() => setDeleteId(p.id)}>
                    <Trash2 className="w-4 h-4 text-destructive" />
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>

      {/* Create/Edit Dialog */}
      <Dialog open={isFormOpen} onOpenChange={setIsFormOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {editingId
                ? t('admin.identityProviders.edit')
                : t('admin.identityProviders.add')}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-2">
            <div>
              <Label>{t('common.name')}</Label>
              <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <Label>{t('admin.identityProviders.protocol')}</Label>
              <Select value={form.protocol} onValueChange={(v) => setForm({ ...form, protocol: v as 'oidc' | 'oauth2' })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="oidc">OIDC</SelectItem>
                  <SelectItem value="oauth2">OAuth2</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.protocol === 'oidc' ? (
              <div>
                <Label>{t('admin.identityProviders.discoveryUrl')}</Label>
                <Input value={form.discoveryUrl} onChange={(e) => setForm({ ...form, discoveryUrl: e.target.value })} placeholder="https://..." />
              </div>
            ) : (
              <>
                <div>
                  <Label>{t('admin.identityProviders.authorizationUrl')}</Label>
                  <Input value={form.authorizationUrl} onChange={(e) => setForm({ ...form, authorizationUrl: e.target.value })} />
                </div>
                <div>
                  <Label>{t('admin.identityProviders.tokenUrl')}</Label>
                  <Input value={form.tokenUrl} onChange={(e) => setForm({ ...form, tokenUrl: e.target.value })} />
                </div>
                <div>
                  <Label>{t('admin.identityProviders.userinfoUrl')}</Label>
                  <Input value={form.userinfoUrl} onChange={(e) => setForm({ ...form, userinfoUrl: e.target.value })} />
                </div>
              </>
            )}

            <div>
              <Label>{t('admin.identityProviders.clientId')}</Label>
              <Input value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
            </div>
            <div>
              <Label>
                {t('admin.identityProviders.clientSecret')}
                {editingId && <span className="text-xs text-muted-foreground ms-1">({t('admin.identityProviders.leaveBlank')})</span>}
              </Label>
              <Input type="password" value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} />
            </div>
            <div>
              <Label>{t('admin.identityProviders.scopes')}</Label>
              <Input value={form.scopes} onChange={(e) => setForm({ ...form, scopes: e.target.value })} />
            </div>
            <div>
              <Label>{t('admin.identityProviders.instituteType')}</Label>
              <Input value={form.instituteIdType} onChange={(e) => setForm({ ...form, instituteIdType: e.target.value })} placeholder="MOE, MOH, ..." />
            </div>
            <div>
              <Label>{t('admin.identityProviders.reverificationDays')}</Label>
              <Input type="number" value={form.reverificationDays} onChange={(e) => setForm({ ...form, reverificationDays: e.target.value })} placeholder={t('admin.identityProviders.neverPlaceholder')} />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setIsFormOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
              {saveMutation.isPending && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('common.save')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteId} onOpenChange={(open) => { if (!open) setDeleteId(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('admin.identityProviders.deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('admin.identityProviders.deleteDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel')}</AlertDialogCancel>
            <AlertDialogAction onClick={() => deleteId && deleteMutation.mutate(deleteId)}>
              {t('common.delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
