import { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Switch } from '@/components/ui/switch';
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

type Protocol = 'oidc' | 'oauth2' | 'saml';

interface IdentityProvider {
  id: string;
  name: string;
  protocol: Protocol;
  discoveryUrl?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  clientId?: string | null;
  scopes?: string;
  claimMappings?: Record<string, unknown>;
  instituteIdType?: string;
  reverificationDays?: number;
  autoProvision?: boolean;
  isActive: boolean;
  // SAML 2.0 fields
  samlEntityId?: string | null;
  samlSsoUrl?: string | null;
  samlSloUrl?: string | null;
  samlX509Cert?: string | null;
  samlNameIdFormat?: string | null;
  samlSignAuthnRequests?: boolean | null;
  samlWantAssertionsSigned?: boolean | null;
  samlSpEntityId?: string | null;
  samlSpCertificate?: string | null;
  createdAt: string;
  updatedAt: string;
}

const QUERY_KEY = ['/api/admin/identity-providers'];

const emptyForm = {
  name: '',
  protocol: 'oidc' as Protocol,
  // OIDC / OAuth2
  discoveryUrl: '',
  authorizationUrl: '',
  tokenUrl: '',
  userinfoUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid email profile',
  // SAML
  samlEntityId: '',
  samlSsoUrl: '',
  samlSloUrl: '',
  samlX509Cert: '',
  samlNameIdFormat: 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
  samlSignAuthnRequests: false,
  samlWantAssertionsSigned: true,
  samlSpEntityId: '',
  samlSpPrivateKey: '',
  samlSpCertificate: '',
  // Common
  instituteIdType: '',
  reverificationDays: '',
  autoProvision: false,
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
        instituteIdType: form.instituteIdType || null,
        reverificationDays: form.reverificationDays ? parseInt(form.reverificationDays) : null,
        autoProvision: form.autoProvision,
        isActive: form.isActive,
      };

      if (form.protocol === 'saml') {
        // SAML doesn't use clientId/clientSecret/scopes — leave them null/default.
        body.samlEntityId = form.samlEntityId || null;
        body.samlSsoUrl = form.samlSsoUrl || null;
        body.samlSloUrl = form.samlSloUrl || null;
        body.samlX509Cert = form.samlX509Cert || null;
        body.samlNameIdFormat = form.samlNameIdFormat || null;
        body.samlSignAuthnRequests = form.samlSignAuthnRequests;
        body.samlWantAssertionsSigned = form.samlWantAssertionsSigned;
        body.samlSpEntityId = form.samlSpEntityId || null;
        body.samlSpCertificate = form.samlSpCertificate || null;
        if (form.samlSpPrivateKey) body.samlSpPrivateKey = form.samlSpPrivateKey;

        if (!editingId) {
          if (!form.samlSsoUrl) throw new Error('SAML SSO URL is required');
          if (!form.samlX509Cert) throw new Error('SAML IdP certificate is required');
        }
      } else {
        body.clientId = form.clientId;
        body.scopes = form.scopes || 'openid email profile';
        if (form.clientSecret) body.clientSecret = form.clientSecret;
        if (form.protocol === 'oidc') {
          body.discoveryUrl = form.discoveryUrl || null;
        } else {
          body.authorizationUrl = form.authorizationUrl || null;
          body.tokenUrl = form.tokenUrl || null;
          body.userinfoUrl = form.userinfoUrl || null;
        }

        if (!editingId) {
          if (!form.clientSecret) throw new Error('Client secret is required');
          body.clientSecret = form.clientSecret;
        }
      }

      if (editingId) {
        await apiRequest('PATCH', `/api/admin/identity-providers/${editingId}`, body);
      } else {
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
      clientId: provider.clientId || '',
      clientSecret: '', // never sent back from server
      scopes: provider.scopes || 'openid email profile',
      samlEntityId: provider.samlEntityId || '',
      samlSsoUrl: provider.samlSsoUrl || '',
      samlSloUrl: provider.samlSloUrl || '',
      samlX509Cert: provider.samlX509Cert || '',
      samlNameIdFormat: provider.samlNameIdFormat || 'urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress',
      samlSignAuthnRequests: !!provider.samlSignAuthnRequests,
      samlWantAssertionsSigned: provider.samlWantAssertionsSigned !== false,
      samlSpEntityId: provider.samlSpEntityId || '',
      samlSpPrivateKey: '', // never sent back from server
      samlSpCertificate: provider.samlSpCertificate || '',
      instituteIdType: provider.instituteIdType || '',
      reverificationDays: provider.reverificationDays?.toString() || '',
      autoProvision: !!provider.autoProvision,
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
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
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
              <Select value={form.protocol} onValueChange={(v) => setForm({ ...form, protocol: v as Protocol })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="oidc">OIDC</SelectItem>
                  <SelectItem value="oauth2">OAuth2</SelectItem>
                  <SelectItem value="saml">SAML 2.0</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {form.protocol === 'saml' ? (
              <>
                <div>
                  <Label>{t('admin.identityProviders.samlSsoUrl')}</Label>
                  <Input value={form.samlSsoUrl} onChange={(e) => setForm({ ...form, samlSsoUrl: e.target.value })} placeholder="https://idp.example.com/sso" />
                </div>
                <div>
                  <Label>{t('admin.identityProviders.samlEntityId')}</Label>
                  <Input value={form.samlEntityId} onChange={(e) => setForm({ ...form, samlEntityId: e.target.value })} placeholder="https://idp.example.com/entity" />
                </div>
                <div>
                  <Label>{t('admin.identityProviders.samlX509Cert')}</Label>
                  <Textarea
                    value={form.samlX509Cert}
                    onChange={(e) => setForm({ ...form, samlX509Cert: e.target.value })}
                    rows={6}
                    placeholder="-----BEGIN CERTIFICATE-----..."
                    className="font-mono text-xs"
                  />
                </div>
                <div>
                  <Label>{t('admin.identityProviders.samlNameIdFormat')}</Label>
                  <Input value={form.samlNameIdFormat} onChange={(e) => setForm({ ...form, samlNameIdFormat: e.target.value })} />
                </div>
                <div>
                  <Label>{t('admin.identityProviders.samlSloUrl')}</Label>
                  <Input value={form.samlSloUrl} onChange={(e) => setForm({ ...form, samlSloUrl: e.target.value })} placeholder="(optional)" />
                </div>
                <div className="flex items-center justify-between">
                  <Label>{t('admin.identityProviders.samlWantAssertionsSigned')}</Label>
                  <Switch checked={form.samlWantAssertionsSigned} onCheckedChange={(v) => setForm({ ...form, samlWantAssertionsSigned: v })} />
                </div>
                <div className="flex items-center justify-between">
                  <Label>{t('admin.identityProviders.samlSignAuthnRequests')}</Label>
                  <Switch checked={form.samlSignAuthnRequests} onCheckedChange={(v) => setForm({ ...form, samlSignAuthnRequests: v })} />
                </div>
                <div>
                  <Label>{t('admin.identityProviders.samlSpEntityId')}</Label>
                  <Input value={form.samlSpEntityId} onChange={(e) => setForm({ ...form, samlSpEntityId: e.target.value })} placeholder={t('admin.identityProviders.samlSpEntityIdPlaceholder')} />
                </div>
                {form.samlSignAuthnRequests && (
                  <>
                    <div>
                      <Label>
                        {t('admin.identityProviders.samlSpPrivateKey')}
                        {editingId && <span className="text-xs text-muted-foreground ms-1">({t('admin.identityProviders.leaveBlank')})</span>}
                      </Label>
                      <Textarea
                        value={form.samlSpPrivateKey}
                        onChange={(e) => setForm({ ...form, samlSpPrivateKey: e.target.value })}
                        rows={4}
                        placeholder="-----BEGIN PRIVATE KEY-----..."
                        className="font-mono text-xs"
                      />
                    </div>
                    <div>
                      <Label>{t('admin.identityProviders.samlSpCertificate')}</Label>
                      <Textarea
                        value={form.samlSpCertificate}
                        onChange={(e) => setForm({ ...form, samlSpCertificate: e.target.value })}
                        rows={4}
                        placeholder="-----BEGIN CERTIFICATE-----..."
                        className="font-mono text-xs"
                      />
                    </div>
                  </>
                )}
                {editingId && (
                  <div className="rounded-md border bg-muted/30 p-3 text-xs">
                    <div className="font-medium mb-1">{t('admin.identityProviders.samlMetadataLabel')}</div>
                    <code className="break-all">{`/api/identity/saml/metadata/${editingId}`}</code>
                  </div>
                )}
              </>
            ) : form.protocol === 'oidc' ? (
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

            {form.protocol !== 'saml' && (
              <>
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
              </>
            )}
            <div>
              <Label>{t('admin.identityProviders.instituteType')}</Label>
              <Input value={form.instituteIdType} onChange={(e) => setForm({ ...form, instituteIdType: e.target.value })} placeholder="MOE, MOH, ..." />
            </div>
            <div>
              <Label>{t('admin.identityProviders.reverificationDays')}</Label>
              <Input type="number" value={form.reverificationDays} onChange={(e) => setForm({ ...form, reverificationDays: e.target.value })} placeholder={t('admin.identityProviders.neverPlaceholder')} />
            </div>
            <div className="flex items-start gap-3 col-span-full">
              <input
                id="provider-auto-provision"
                type="checkbox"
                checked={form.autoProvision}
                onChange={(e) => setForm({ ...form, autoProvision: e.target.checked })}
                className="mt-1"
              />
              <div className="flex-1">
                <Label htmlFor="provider-auto-provision" className="cursor-pointer">
                  {t('admin.identityProviders.autoProvision') || 'Auto-provision new users'}
                </Label>
                <p className="text-xs text-muted-foreground">
                  {t('admin.identityProviders.autoProvisionDesc') || 'When a user authenticates via this IdP and has no Aivota account, create one from the SSO claims and link it. Required for institutional IdPs (e.g. IL MoE Sapakim) where users expect to land already-logged-in.'}
                </p>
              </div>
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
