// src/features/InstitutePanel.tsx
// Panel for managing institutes - view, create, edit, and manage members/invites

import { useState, useEffect, useCallback } from 'react';
import { useAuth } from '@/hooks/useAuth';
import { useInstitute, Institute, InstituteMember, InstituteInvite } from '@/hooks/useInstitute';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Switch } from '@/components/ui/switch';
import { Separator } from '@/components/ui/separator';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
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
} from "@/components/ui/alert-dialog";
import {
  Building2,
  Plus,
  Settings,
  Users,
  Mail,
  MoreHorizontal,
  Crown,
  Trash2,
  Copy,
  RefreshCw,
  UserPlus,
  Clock,
  CheckCircle,
  XCircle,
  LogOut,
  Edit,
  School,
  Hospital,
  Loader2,
} from 'lucide-react';

interface InstitutePanelProps {
  isOpen: boolean;
  onClose?: () => void;
}

export function InstitutePanel({ isOpen, onClose }: InstitutePanelProps) {
  const { t, isRTL, language } = useLanguage();
  const { theme } = useTheme();
  const isDark = theme === 'dark';
  const { user } = useAuth();
  const { toast } = useToast();
  
  const {
    institutes,
    currentInstitute,
    isLoading,
    selectInstitute,
    createInstitute,
    updateInstitute,
    deleteInstitute,
    leaveInstitute,
    getMembers,
    updateMember,
    removeMember,
    sendInvite,
    getInvites,
    cancelInvite,
    resendInvite,
    refetchInstitutes,
  } = useInstitute();

  // Local state
  const [activeTab, setActiveTab] = useState<'overview' | 'members' | 'invites' | 'settings'>('overview');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showInviteDialog, setShowInviteDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showLeaveConfirm, setShowLeaveConfirm] = useState(false);
  
  const [members, setMembers] = useState<InstituteMember[]>([]);
  const [invites, setInvites] = useState<InstituteInvite[]>([]);
  const [loadingMembers, setLoadingMembers] = useState(false);
  const [loadingInvites, setLoadingInvites] = useState(false);

  // Form state
  const [createForm, setCreateForm] = useState({
    name: '',
    type: 'school' as 'school' | 'hospital',
    description: '',
    address: '',
    phone: '',
    email: '',
    website: '',
  });
  const [editForm, setEditForm] = useState<Partial<Institute>>({});
  const [inviteForm, setInviteForm] = useState({
    email: '',
    role: 'staff',
    grantAdmin: false,
    message: '',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Load members when tab changes
  useEffect(() => {
    if (currentInstitute && activeTab === 'members') {
      loadMembers();
    }
  }, [currentInstitute, activeTab]);

  // Load invites when tab changes
  useEffect(() => {
    if (currentInstitute && activeTab === 'invites') {
      loadInvites();
    }
  }, [currentInstitute, activeTab]);

  const loadMembers = async () => {
    if (!currentInstitute) return;
    setLoadingMembers(true);
    try {
      const membersList = await getMembers(currentInstitute.id);
      setMembers(membersList);
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoadingMembers(false);
    }
  };

  const loadInvites = async () => {
    if (!currentInstitute) return;
    setLoadingInvites(true);
    try {
      const invitesList = await getInvites(currentInstitute.id);
      setInvites(invitesList);
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setLoadingInvites(false);
    }
  };

  const handleCreateInstitute = async () => {
    if (!createForm.name.trim()) {
      toast({
        title: t('institute.error') || 'Error',
        description: t('institute.nameRequired') || 'Name is required',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const newInstitute = await createInstitute(createForm);
      selectInstitute(newInstitute.id);
      setShowCreateDialog(false);
      setCreateForm({
        name: '',
        type: 'school',
        description: '',
        address: '',
        phone: '',
        email: '',
        website: '',
      });
      toast({
        title: t('institute.created') || 'Institute Created',
        description: t('institute.createdDesc') || 'Your institute has been created successfully.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleUpdateInstitute = async () => {
    if (!currentInstitute) return;

    setIsSubmitting(true);
    try {
      await updateInstitute(currentInstitute.id, editForm);
      setShowEditDialog(false);
      toast({
        title: t('institute.updated') || 'Institute Updated',
        description: t('institute.updatedDesc') || 'Changes saved successfully.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDeleteInstitute = async () => {
    if (!currentInstitute) return;

    setIsSubmitting(true);
    try {
      await deleteInstitute(currentInstitute.id);
      setShowDeleteConfirm(false);
      toast({
        title: t('institute.deleted') || 'Institute Deleted',
        description: t('institute.deletedDesc') || 'The institute has been deleted.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLeaveInstitute = async () => {
    if (!currentInstitute) return;

    setIsSubmitting(true);
    try {
      await leaveInstitute(currentInstitute.id);
      setShowLeaveConfirm(false);
      toast({
        title: t('institute.left') || 'Left Institute',
        description: t('institute.leftDesc') || 'You have left the institute.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSendInvite = async () => {
    if (!currentInstitute || !inviteForm.email.trim()) {
      toast({
        title: t('institute.error') || 'Error',
        description: t('institute.emailRequired') || 'Email is required',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const { inviteLink } = await sendInvite(currentInstitute.id, inviteForm.email, {
        role: inviteForm.role,
        grantAdmin: inviteForm.grantAdmin,
        message: inviteForm.message || undefined,
      });
      
      // Copy link to clipboard
      await navigator.clipboard.writeText(inviteLink);
      
      setShowInviteDialog(false);
      setInviteForm({ email: '', role: 'staff', grantAdmin: false, message: '' });
      loadInvites();
      
      toast({
        title: t('institute.inviteSent') || 'Invite Sent',
        description: t('institute.inviteSentDesc') || 'The invite link has been copied to your clipboard.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelInvite = async (inviteId: string) => {
    if (!currentInstitute) return;

    try {
      await cancelInvite(currentInstitute.id, inviteId);
      loadInvites();
      toast({
        title: t('institute.inviteCancelled') || 'Invite Cancelled',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const handleResendInvite = async (inviteId: string) => {
    if (!currentInstitute) return;

    try {
      const { inviteLink } = await resendInvite(currentInstitute.id, inviteId);
      await navigator.clipboard.writeText(inviteLink);
      loadInvites();
      toast({
        title: t('institute.inviteResent') || 'Invite Resent',
        description: t('institute.inviteLinkCopied') || 'New invite link copied to clipboard.',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const handleToggleAdmin = async (memberId: string, isCurrentlyAdmin: boolean) => {
    if (!currentInstitute) return;

    try {
      await updateMember(currentInstitute.id, memberId, { isAdmin: !isCurrentlyAdmin });
      loadMembers();
      toast({
        title: t('institute.memberUpdated') || 'Member Updated',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const handleRemoveMember = async (memberId: string) => {
    if (!currentInstitute) return;

    try {
      await removeMember(currentInstitute.id, memberId);
      loadMembers();
      toast({
        title: t('institute.memberRemoved') || 'Member Removed',
      });
    } catch (error: any) {
      toast({
        title: t('institute.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    }
  };

  const openEditDialog = () => {
    if (currentInstitute) {
      setEditForm({
        name: currentInstitute.name,
        type: currentInstitute.type,
        description: currentInstitute.description || '',
        address: currentInstitute.address || '',
        phone: currentInstitute.phone || '',
        email: currentInstitute.email || '',
        website: currentInstitute.website || '',
      });
      setShowEditDialog(true);
    }
  };

  const getStatusBadge = (status: string) => {
    const statusConfig: Record<string, { variant: 'default' | 'secondary' | 'destructive' | 'outline'; icon: any }> = {
      pending: { variant: 'secondary', icon: Clock },
      accepted: { variant: 'default', icon: CheckCircle },
      declined: { variant: 'destructive', icon: XCircle },
      expired: { variant: 'outline', icon: Clock },
      cancelled: { variant: 'outline', icon: XCircle },
    };
    const config = statusConfig[status] || statusConfig.pending;
    const Icon = config.icon;

    return (
      <Badge variant={config.variant} className="gap-1">
        <Icon className="w-3 h-3" />
        {t(`institute.status.${status}`) || status}
      </Badge>
    );
  };

  if (!isOpen) return null;

  // No institute selected - show list or create prompt
  if (!currentInstitute) {
    return (
      <div
        dir={isRTL ? 'rtl' : 'ltr'}
        className={cn(
          'flex flex-col h-full min-h-0',
          isDark ? 'bg-slate-950' : 'bg-gray-50'
        )}
      >
        {/* Header */}
        <div className={cn(
          'p-4 border-b shrink-0',
          isDark ? 'border-slate-800 bg-slate-900' : 'border-gray-200 bg-white'
        )}>
          <div className="flex justify-between items-center">
            <div>
              <h1 className={cn(
                'text-xl font-bold',
                isDark ? 'text-white' : 'text-slate-900'
              )}>
                {t('institute.title') || 'Institutes'}
              </h1>
              <p className={cn(
                'text-sm',
                isDark ? 'text-slate-400' : 'text-slate-600'
              )}>
                {t('institute.subtitle') || 'Manage your organization memberships'}
              </p>
            </div>
            <Button onClick={() => setShowCreateDialog(true)} className="gap-2">
              <Plus className="w-4 h-4" />
              {t('institute.create') || 'Create Institute'}
            </Button>
          </div>
        </div>

        {/* Institute List */}
        <ScrollArea className="flex-1">
          <div className="p-4 space-y-3">
            {isLoading ? (
              <div className="flex items-center justify-center py-12">
                <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
              </div>
            ) : institutes.length === 0 ? (
              <div className="text-center py-12">
                <Building2 className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                <p className={cn(
                  'text-lg font-medium mb-2',
                  isDark ? 'text-slate-300' : 'text-slate-700'
                )}>
                  {t('institute.noInstitutes') || 'No institutes yet'}
                </p>
                <p className="text-sm text-muted-foreground mb-4">
                  {t('institute.noInstitutesDesc') || 'Create an institute to manage your organization.'}
                </p>
                <Button onClick={() => setShowCreateDialog(true)}>
                  <Plus className="w-4 h-4 me-2" />
                  {t('institute.createFirst') || 'Create Your First Institute'}
                </Button>
              </div>
            ) : (
              institutes.map((institute) => (
                <Card
                  key={institute.id}
                  className={cn(
                    'cursor-pointer transition-all hover:shadow-md',
                    isDark ? 'bg-slate-900 border-slate-800 hover:border-slate-700' : 'bg-white hover:border-primary/20'
                  )}
                  onClick={() => selectInstitute(institute.id)}
                >
                  <CardContent className="p-4 flex items-center gap-4">
                    <div className={cn(
                      'w-12 h-12 rounded-lg flex items-center justify-center',
                      isDark ? 'bg-slate-800' : 'bg-secondary'
                    )}>
                      {institute.type === 'hospital' ? (
                        <Hospital className="w-6 h-6 text-primary" />
                      ) : (
                        <School className="w-6 h-6 text-primary" />
                      )}
                    </div>
                    <div className="flex-1">
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold">{institute.name}</h3>
                        {institute.isAdmin && (
                          <Badge variant="secondary" className="gap-1">
                            <Crown className="w-3 h-3" />
                            {t('institute.admin') || 'Admin'}
                          </Badge>
                        )}
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {t(`institute.type.${institute.type}`) || institute.type}
                        {institute.role && ` • ${institute.role}`}
                      </p>
                    </div>
                  </CardContent>
                </Card>
              ))
            )}
          </div>
        </ScrollArea>

        {/* Create Dialog */}
        <Dialog open={showCreateDialog} onOpenChange={setShowCreateDialog}>
          <DialogContent className="sm:max-w-[500px]">
            <DialogHeader>
              <DialogTitle>{t('institute.create') || 'Create Institute'}</DialogTitle>
              <DialogDescription>
                {t('institute.createDesc') || 'Create a new institute to manage your organization.'}
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-4 py-4">
              <div className="space-y-2">
                <Label htmlFor="name">{t('institute.name') || 'Name'} *</Label>
                <Input
                  id="name"
                  value={createForm.name}
                  onChange={(e) => setCreateForm({ ...createForm, name: e.target.value })}
                  placeholder={t('institute.namePlaceholder') || 'Enter institute name'}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="type">{t('institute.typeLabel') || 'Type'}</Label>
                <Select
                  value={createForm.type}
                  onValueChange={(value: 'school' | 'hospital') => setCreateForm({ ...createForm, type: value })}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="school">
                      <span className="flex items-center gap-2">
                        <School className="w-4 h-4" />
                        {t('institute.type.school') || 'School'}
                      </span>
                    </SelectItem>
                    <SelectItem value="hospital">
                      <span className="flex items-center gap-2">
                        <Hospital className="w-4 h-4" />
                        {t('institute.type.hospital') || 'Hospital'}
                      </span>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="description">{t('institute.description') || 'Description'}</Label>
                <Textarea
                  id="description"
                  value={createForm.description}
                  onChange={(e) => setCreateForm({ ...createForm, description: e.target.value })}
                  placeholder={t('institute.descriptionPlaceholder') || 'Brief description of the institute'}
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setShowCreateDialog(false)}>
                {t('common.cancel') || 'Cancel'}
              </Button>
              <Button onClick={handleCreateInstitute} disabled={isSubmitting}>
                {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
                {t('common.save') || 'Create'}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    );
  }

  // Institute selected - show details with tabs
  return (
    <div
      dir={isRTL ? 'rtl' : 'ltr'}
      className={cn(
        'flex flex-col h-full min-h-0',
        isDark ? 'bg-slate-950' : 'bg-gray-50'
      )}
    >
      {/* Header */}
      <div className={cn(
        'p-4 border-b shrink-0',
        isDark ? 'border-slate-800 bg-slate-900' : 'border-gray-200 bg-white'
      )}>
        <div className="flex items-center gap-4 mb-4">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => selectInstitute(null)}
          >
            {t('common.back') || '← Back'}
          </Button>
          <div className="flex-1">
            <div className="flex items-center gap-2">
              <h1 className={cn(
                'text-xl font-bold',
                isDark ? 'text-white' : 'text-slate-900'
              )}>
                {currentInstitute.name}
              </h1>
              {currentInstitute.isAdmin && (
                <Badge variant="secondary" className="gap-1">
                  <Crown className="w-3 h-3" />
                  {t('institute.admin') || 'Admin'}
                </Badge>
              )}
            </div>
            <p className="text-sm text-muted-foreground">
              {t(`institute.type.${currentInstitute.type}`) || currentInstitute.type}
            </p>
          </div>
          {currentInstitute.isAdmin ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="icon">
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                <DropdownMenuItem onClick={openEditDialog}>
                  <Edit className="w-4 h-4 me-2" />
                  {t('institute.edit') || 'Edit Details'}
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  className="text-destructive"
                  onClick={() => setShowDeleteConfirm(true)}
                >
                  <Trash2 className="w-4 h-4 me-2" />
                  {t('institute.delete') || 'Delete Institute'}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowLeaveConfirm(true)}
            >
              <LogOut className="w-4 h-4 me-2" />
              {t('institute.leave') || 'Leave'}
            </Button>
          )}
        </div>

        <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as any)}>
          <TabsList>
            <TabsTrigger value="overview">
              {t('institute.tabs.overview') || 'Overview'}
            </TabsTrigger>
            <TabsTrigger value="members">
              {t('institute.tabs.members') || 'Members'}
            </TabsTrigger>
            {currentInstitute.isAdmin && (
              <TabsTrigger value="invites">
                {t('institute.tabs.invites') || 'Invites'}
              </TabsTrigger>
            )}
            {currentInstitute.isAdmin && (
              <TabsTrigger value="settings">
                {t('institute.tabs.settings') || 'Settings'}
              </TabsTrigger>
            )}
          </TabsList>
        </Tabs>
      </div>

      {/* Content */}
      <ScrollArea className="flex-1">
        <div className="p-4">
          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>{t('institute.details') || 'Details'}</CardTitle>
                </CardHeader>
                <CardContent className="space-y-4">
                  {currentInstitute.description && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.description') || 'Description'}</Label>
                      <p>{currentInstitute.description}</p>
                    </div>
                  )}
                  {currentInstitute.address && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.address') || 'Address'}</Label>
                      <p>{currentInstitute.address}</p>
                    </div>
                  )}
                  {currentInstitute.phone && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.phone') || 'Phone'}</Label>
                      <p dir="ltr">{currentInstitute.phone}</p>
                    </div>
                  )}
                  {currentInstitute.email && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.email') || 'Email'}</Label>
                      <p dir="ltr">{currentInstitute.email}</p>
                    </div>
                  )}
                  {currentInstitute.website && (
                    <div>
                      <Label className="text-muted-foreground">{t('institute.website') || 'Website'}</Label>
                      <p dir="ltr">
                        <a href={currentInstitute.website} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
                          {currentInstitute.website}
                        </a>
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}

          {/* Members Tab */}
          {activeTab === 'members' && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold">
                  {t('institute.membersCount', { count: members.length }) || `${members.length} Members`}
                </h2>
                {currentInstitute.isAdmin && (
                  <Button onClick={() => setShowInviteDialog(true)}>
                    <UserPlus className="w-4 h-4 me-2" />
                    {t('institute.inviteMember') || 'Invite Member'}
                  </Button>
                )}
              </div>

              {loadingMembers ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : (
                <div className="space-y-2">
                  {members.map((member) => (
                    <Card key={member.id}>
                      <CardContent className="p-4 flex items-center gap-4">
                        <div className={cn(
                          'w-10 h-10 rounded-full flex items-center justify-center font-medium',
                          isDark ? 'bg-slate-800 text-slate-300' : 'bg-secondary text-secondary-foreground'
                        )}>
                          {member.fullName?.split(' ').map(n => n[0]).join('') || member.email[0].toUpperCase()}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium">{member.fullName || member.email}</span>
                            {member.isAdmin && (
                              <Badge variant="secondary" className="gap-1">
                                <Crown className="w-3 h-3" />
                                {t('institute.admin') || 'Admin'}
                              </Badge>
                            )}
                          </div>
                          <p className="text-sm text-muted-foreground">{member.email}</p>
                        </div>
                        <Badge variant="outline">{member.role}</Badge>
                        {currentInstitute.isAdmin && member.id !== user?.id && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                              <DropdownMenuItem onClick={() => handleToggleAdmin(member.id, member.isAdmin)}>
                                <Crown className="w-4 h-4 me-2" />
                                {member.isAdmin 
                                  ? (t('institute.removeAdmin') || 'Remove Admin')
                                  : (t('institute.makeAdmin') || 'Make Admin')
                                }
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => handleRemoveMember(member.id)}
                              >
                                <Trash2 className="w-4 h-4 me-2" />
                                {t('institute.removeMember') || 'Remove Member'}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Invites Tab */}
          {activeTab === 'invites' && currentInstitute.isAdmin && (
            <div className="space-y-4">
              <div className="flex justify-between items-center">
                <h2 className="text-lg font-semibold">
                  {t('institute.pendingInvites') || 'Pending Invites'}
                </h2>
                <Button onClick={() => setShowInviteDialog(true)}>
                  <UserPlus className="w-4 h-4 me-2" />
                  {t('institute.sendInvite') || 'Send Invite'}
                </Button>
              </div>

              {loadingInvites ? (
                <div className="flex items-center justify-center py-12">
                  <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
                </div>
              ) : invites.length === 0 ? (
                <div className="text-center py-12">
                  <Mail className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
                  <p className="text-muted-foreground">
                    {t('institute.noInvites') || 'No invites sent yet'}
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  {invites.map((invite) => (
                    <Card key={invite.id}>
                      <CardContent className="p-4 flex items-center gap-4">
                        <Mail className="w-5 h-5 text-muted-foreground" />
                        <div className="flex-1">
                          <p className="font-medium" dir="ltr">{invite.inviteeEmail}</p>
                          <p className="text-sm text-muted-foreground">
                            {invite.role}
                            {invite.grantAdmin && ` • ${t('institute.willBeAdmin') || 'Will be admin'}`}
                          </p>
                        </div>
                        {getStatusBadge(invite.status)}
                        {invite.status === 'pending' && (
                          <DropdownMenu>
                            <DropdownMenuTrigger asChild>
                              <Button variant="ghost" size="icon">
                                <MoreHorizontal className="w-4 h-4" />
                              </Button>
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align={isRTL ? 'start' : 'end'}>
                              <DropdownMenuItem onClick={() => handleResendInvite(invite.id)}>
                                <RefreshCw className="w-4 h-4 me-2" />
                                {t('institute.resend') || 'Resend'}
                              </DropdownMenuItem>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                className="text-destructive"
                                onClick={() => handleCancelInvite(invite.id)}
                              >
                                <XCircle className="w-4 h-4 me-2" />
                                {t('institute.cancel') || 'Cancel'}
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </CardContent>
                    </Card>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Settings Tab */}
          {activeTab === 'settings' && currentInstitute.isAdmin && (
            <div className="space-y-6">
              <Card>
                <CardHeader>
                  <CardTitle>{t('institute.dangerZone') || 'Danger Zone'}</CardTitle>
                  <CardDescription>
                    {t('institute.dangerZoneDesc') || 'Irreversible actions for this institute'}
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <Button
                    variant="destructive"
                    onClick={() => setShowDeleteConfirm(true)}
                  >
                    <Trash2 className="w-4 h-4 me-2" />
                    {t('institute.deleteInstitute') || 'Delete Institute'}
                  </Button>
                </CardContent>
              </Card>
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Invite Dialog */}
      <Dialog open={showInviteDialog} onOpenChange={setShowInviteDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('institute.inviteMember') || 'Invite Member'}</DialogTitle>
            <DialogDescription>
              {t('institute.inviteMemberDesc') || 'Send an invitation to join this institute.'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="inviteEmail">{t('institute.email') || 'Email'} *</Label>
              <Input
                id="inviteEmail"
                type="email"
                dir="ltr"
                value={inviteForm.email}
                onChange={(e) => setInviteForm({ ...inviteForm, email: e.target.value })}
                placeholder="email@example.com"
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inviteRole">{t('institute.role') || 'Role'}</Label>
              <Select
                value={inviteForm.role}
                onValueChange={(value) => setInviteForm({ ...inviteForm, role: value })}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="staff">{t('institute.roles.staff') || 'Staff'}</SelectItem>
                  <SelectItem value="therapist">{t('institute.roles.therapist') || 'Therapist'}</SelectItem>
                  <SelectItem value="teacher">{t('institute.roles.teacher') || 'Teacher'}</SelectItem>
                  <SelectItem value="admin">{t('institute.roles.admin') || 'Administrator'}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-center justify-between">
              <Label htmlFor="grantAdmin">{t('institute.grantAdmin') || 'Grant Admin Access'}</Label>
              <Switch
                id="grantAdmin"
                checked={inviteForm.grantAdmin}
                onCheckedChange={(checked) => setInviteForm({ ...inviteForm, grantAdmin: checked })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="inviteMessage">{t('institute.message') || 'Message (Optional)'}</Label>
              <Textarea
                id="inviteMessage"
                value={inviteForm.message}
                onChange={(e) => setInviteForm({ ...inviteForm, message: e.target.value })}
                placeholder={t('institute.messagePlaceholder') || 'Add a personal message...'}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowInviteDialog(false)}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button onClick={handleSendInvite} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('institute.sendInvite') || 'Send Invite'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Edit Dialog */}
      <Dialog open={showEditDialog} onOpenChange={setShowEditDialog}>
        <DialogContent className="sm:max-w-[500px]">
          <DialogHeader>
            <DialogTitle>{t('institute.edit') || 'Edit Institute'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="space-y-2">
              <Label htmlFor="editName">{t('institute.name') || 'Name'}</Label>
              <Input
                id="editName"
                value={editForm.name || ''}
                onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="editDescription">{t('institute.description') || 'Description'}</Label>
              <Textarea
                id="editDescription"
                value={editForm.description || ''}
                onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="editAddress">{t('institute.address') || 'Address'}</Label>
              <Input
                id="editAddress"
                value={editForm.address || ''}
                onChange={(e) => setEditForm({ ...editForm, address: e.target.value })}
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="editPhone">{t('institute.phone') || 'Phone'}</Label>
                <Input
                  id="editPhone"
                  dir="ltr"
                  value={editForm.phone || ''}
                  onChange={(e) => setEditForm({ ...editForm, phone: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="editEmail">{t('institute.email') || 'Email'}</Label>
                <Input
                  id="editEmail"
                  type="email"
                  dir="ltr"
                  value={editForm.email || ''}
                  onChange={(e) => setEditForm({ ...editForm, email: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label htmlFor="editWebsite">{t('institute.website') || 'Website'}</Label>
              <Input
                id="editWebsite"
                dir="ltr"
                value={editForm.website || ''}
                onChange={(e) => setEditForm({ ...editForm, website: e.target.value })}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowEditDialog(false)}>
              {t('common.cancel') || 'Cancel'}
            </Button>
            <Button onClick={handleUpdateInstitute} disabled={isSubmitting}>
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('common.save') || 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={showDeleteConfirm} onOpenChange={setShowDeleteConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('institute.confirmDelete') || 'Delete Institute?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('institute.confirmDeleteDesc') || 'This action cannot be undone. All members will lose access.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel') || 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteInstitute}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('common.delete') || 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Leave Confirmation */}
      <AlertDialog open={showLeaveConfirm} onOpenChange={setShowLeaveConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('institute.confirmLeave') || 'Leave Institute?'}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('institute.confirmLeaveDesc') || 'You will lose access to this institute. You can rejoin if invited again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common.cancel') || 'Cancel'}</AlertDialogCancel>
            <AlertDialogAction onClick={handleLeaveInstitute}>
              {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
              {t('institute.leave') || 'Leave'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
