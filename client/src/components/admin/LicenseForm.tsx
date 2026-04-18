// src/components/admin/LicenseForm.tsx
// Dialog form for creating and editing licenses

import { useState, useEffect, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Separator } from '@/components/ui/separator';
import { useToast } from '@/hooks/use-toast';
import { Loader2, Upload, X } from 'lucide-react';
import {
  useLicenseMutations,
  type AdminLicense,
  type CreateLicenseData,
  type UpdateLicenseData,
} from '@/hooks/useAdminData';
import { useLanguage } from '@/contexts/LanguageContext';

interface LicenseFormProps {
  open: boolean;
  onClose: () => void;
  license: AdminLicense | null; // null = create mode
}

const DASHBOARD_LEVELS = [
  { value: '0', label: 'None' },
  { value: '1', label: 'Basic Stats' },
  { value: '2', label: 'Advanced Analytics' },
  { value: '-1', label: 'Full Analysis' },
] as const;

const USER_TYPES = [
  { value: 'Caregiver', labelEn: 'Caregiver', labelHe: 'מטפל/ת' },
  { value: 'Parent', labelEn: 'Parent', labelHe: 'הורה' },
  { value: 'Teacher', labelEn: 'Teacher', labelHe: 'מורה' },
  { value: 'SLP', labelEn: 'SLP', labelHe: 'קלינאי תקשורת' },
] as const;

export function LicenseForm({ open, onClose, license }: LicenseFormProps) {
  const { toast } = useToast();
  const { t, language } = useLanguage();
  const { createLicense, updateLicense } = useLicenseMutations();
  const isEdit = !!license;
  const logoInputRef = useRef<HTMLInputElement>(null);

  // Recipient fields (create only)
  const [inviteEmail, setInviteEmail] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [userType, setUserType] = useState('Caregiver');

  // Institute fields (create only) — institute is always required
  const [instituteName, setInstituteName] = useState('');
  const [instituteType, setInstituteType] = useState<'school' | 'clinic' | 'family'>('school');
  const [instituteLanguage, setInstituteLanguage] = useState<string>(language || 'en');
  const [instituteLogo, setInstituteLogo] = useState<File | null>(null);
  const [logoPreview, setLogoPreview] = useState<string | null>(null);

  // License fields
  const [name, setName] = useState('');
  const [licenseType, setLicenseType] = useState('standard');
  const [subscriptionType, setSubscriptionType] = useState('monthly');
  const [isTrial, setIsTrial] = useState(false);
  const [trialExpiresAt, setTrialExpiresAt] = useState('');

  // Permissions
  const [grantAll, setGrantAll] = useState(false);
  const [maxStudents, setMaxStudents] = useState(5);
  const [maxStudentsUnlimited, setMaxStudentsUnlimited] = useState(false);
  const [aacEnabled, setAacEnabled] = useState(false);
  const [boardMakerEnabled, setBoardMakerEnabled] = useState(false);
  const [customAppsEnabled, setCustomAppsEnabled] = useState(false);
  const [unrestrictedAI, setUnrestrictedAI] = useState(false);
  const [calendar, setCalendar] = useState(false);
  const [dashboardLevel, setDashboardLevel] = useState('0');
  const [expertAgentsCount, setExpertAgentsCount] = useState(0);
  const [expertAgentsUnlimited, setExpertAgentsUnlimited] = useState(false);
  const [deepAnalysisEnabled, setDeepAnalysisEnabled] = useState(false);

  // Reset form when dialog opens/closes or license changes
  useEffect(() => {
    if (open) {
      if (license) {
        setName(license.name || '');
        setLicenseType(license.licenseType || 'standard');
        setSubscriptionType(license.subscriptionType || 'monthly');
        setIsTrial(license.isTrial || false);
        setTrialExpiresAt(license.trialExpiresAt ? license.trialExpiresAt.split('T')[0] : '');

        const perms = license.permissions;
        if (perms) {
          setGrantAll(perms.all || false);
          setMaxStudents(perms.maxStudents === -1 ? 0 : (perms.maxStudents ?? 0));
          setMaxStudentsUnlimited(perms.maxStudents === -1);
          setAacEnabled(perms.aacEnabled ?? false);
          setBoardMakerEnabled(perms.boardMakerEnabled ?? false);
          setCustomAppsEnabled(perms.customAppsEnabled ?? false);
          setUnrestrictedAI(perms.unrestrictedAI ?? false);
          setCalendar(perms.calendar ?? false);
          setDashboardLevel(String(perms.dashboardLevel ?? 0));
          setExpertAgentsCount(perms.expertAgentsCount === -1 ? 0 : (perms.expertAgentsCount ?? 0));
          setExpertAgentsUnlimited(perms.expertAgentsCount === -1);
          setDeepAnalysisEnabled(perms.deepAnalysisEnabled ?? false);
        } else {
          resetPermissions();
        }
      } else {
        resetAll();
      }
    }
  }, [open, license]);

  function resetPermissions() {
    setGrantAll(false);
    setMaxStudents(5);
    setMaxStudentsUnlimited(false);
    setAacEnabled(false);
    setBoardMakerEnabled(false);
    setCustomAppsEnabled(false);
    setUnrestrictedAI(false);
    setCalendar(false);
    setDashboardLevel('0');
    setExpertAgentsCount(0);
    setExpertAgentsUnlimited(false);
    setDeepAnalysisEnabled(false);
  }

  function resetAll() {
    setInviteEmail('');
    setFirstName('');
    setLastName('');
    setUserType('Caregiver');
    setInstituteName('');
    setInstituteType('school');
    setInstituteLanguage(language || 'en');
    setInstituteLogo(null);
    setLogoPreview(null);
    setName('');
    setLicenseType('standard');
    setSubscriptionType('monthly');
    setIsTrial(false);
    setTrialExpiresAt('');
    resetPermissions();
  }

  function handleLogoChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setInstituteLogo(file);
    const reader = new FileReader();
    reader.onloadend = () => setLogoPreview(reader.result as string);
    reader.readAsDataURL(file);
  }

  function clearLogo() {
    setInstituteLogo(null);
    setLogoPreview(null);
    if (logoInputRef.current) logoInputRef.current.value = '';
  }

  function buildPermissions() {
    if (grantAll) {
      return {
        all: true,
        maxStudents: -1,
        aacEnabled: true,
        boardMakerEnabled: true,
        customAppsEnabled: true,
        unrestrictedAI: true,
        calendar: true,
        dashboardLevel: -1 as -1,
        expertAgentsCount: -1,
        deepAnalysisEnabled: true,
      };
    }
    return {
      all: false,
      maxStudents: maxStudentsUnlimited ? -1 : maxStudents,
      aacEnabled,
      boardMakerEnabled,
      customAppsEnabled,
      unrestrictedAI,
      calendar,
      dashboardLevel: Number(dashboardLevel) as 0 | 1 | 2 | -1,
      expertAgentsCount: expertAgentsUnlimited ? -1 : expertAgentsCount,
      deepAnalysisEnabled,
    };
  }

  async function handleSubmit() {
    try {
      if (isEdit) {
        const data: UpdateLicenseData = {
          name: name || undefined,
          licenseType,
          subscriptionType,
          isTrial,
          trialExpiresAt: isTrial && trialExpiresAt ? trialExpiresAt : undefined,
          permissions: buildPermissions(),
        };
        await updateLicense.mutateAsync({ id: license!.id, data });
        toast({ title: t('admin.licenses.updated') });
      } else {
        if (!inviteEmail) {
          toast({ title: t('admin.licenses.emailRequired'), variant: 'destructive' });
          return;
        }
        if (!instituteName.trim()) {
          toast({ title: t('admin.licenses.instituteNameRequired') || 'Institute name is required', variant: 'destructive' });
          return;
        }
        const data: CreateLicenseData = {
          name: name || undefined,
          licenseType,
          subscriptionType,
          isTrial,
          trialExpiresAt: isTrial && trialExpiresAt ? trialExpiresAt : undefined,
          permissions: buildPermissions(),
          inviteEmail,
          firstName: firstName || undefined,
          lastName: lastName || undefined,
          userType: userType || undefined,
          createInstitute: true,
          instituteName,
          instituteType,
          language: instituteLanguage,
          instituteLogo: instituteLogo || undefined,
        };
        await createLicense.mutateAsync(data);
        toast({ title: t('admin.licenses.created') });
      }
      onClose();
    } catch (err: any) {
      toast({
        title: t('common.error'),
        description: err.message || 'Failed to save license',
        variant: 'destructive',
      });
    }
  }

  const isSubmitting = createLicense.isPending || updateLicense.isPending;

  return (
    <Dialog open={open} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? t('admin.licenses.editLicense') : t('admin.licenses.createLicense')}
          </DialogTitle>
          <DialogDescription>
            {isEdit ? t('admin.licenses.editDescription') : t('admin.licenses.createDescription')}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6 py-4">
          {/* Recipient Section (create only) */}
          {!isEdit && (
            <>
              <div>
                <h3 className="text-sm font-semibold mb-3">{t('admin.licenses.recipient')}</h3>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="inviteEmail">{t('admin.licenses.email')} *</Label>
                    <Input
                      id="inviteEmail"
                      type="email"
                      value={inviteEmail}
                      onChange={(e) => setInviteEmail(e.target.value)}
                      placeholder="user@example.com"
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label htmlFor="firstName">{t('admin.licenses.firstName')}</Label>
                      <Input
                        id="firstName"
                        value={firstName}
                        onChange={(e) => setFirstName(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label htmlFor="lastName">{t('admin.licenses.lastName')}</Label>
                      <Input
                        id="lastName"
                        value={lastName}
                        onChange={(e) => setLastName(e.target.value)}
                      />
                    </div>
                  </div>
                  <div>
                    <Label>{t('admin.licenses.userType')}</Label>
                    <Select value={userType} onValueChange={setUserType}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {USER_TYPES.map((ut) => (
                          <SelectItem key={ut.value} value={ut.value}>
                            {language === 'he' ? ut.labelHe : ut.labelEn}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </div>

              <Separator />

              {/* Institute Section (required — licenses must belong to an institute) */}
              <div>
                <h3 className="text-sm font-semibold mb-3">
                  {t('admin.licenses.institute') || 'Institute'} *
                </h3>
                <div className="space-y-3">
                  <div>
                    <Label htmlFor="instituteName">{t('admin.licenses.instituteName')} *</Label>
                    <Input
                      id="instituteName"
                      value={instituteName}
                      onChange={(e) => setInstituteName(e.target.value)}
                      placeholder={t('admin.licenses.instituteNamePlaceholder') || 'Enter institute name'}
                    />
                  </div>
                  <div>
                    <Label>{t('admin.licenses.instituteType')}</Label>
                    <Select value={instituteType} onValueChange={(v) => setInstituteType(v as 'school' | 'clinic' | 'family')}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="school">{t('admin.licenses.school')}</SelectItem>
                        <SelectItem value="clinic">{t('admin.licenses.clinic')}</SelectItem>
                        <SelectItem value="family">{t('admin.licenses.family')}</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>{t('admin.licenses.instituteLanguage') || 'Language'}</Label>
                    <Select value={instituteLanguage} onValueChange={setInstituteLanguage}>
                      <SelectTrigger>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="en">English</SelectItem>
                        <SelectItem value="he">עברית (Hebrew)</SelectItem>
                        <SelectItem value="es">Español (Spanish)</SelectItem>
                        <SelectItem value="pt">Português (Portuguese)</SelectItem>
                        <SelectItem value="fr">Français (French)</SelectItem>
                        <SelectItem value="ru">Русский (Russian)</SelectItem>
                        <SelectItem value="de">Deutsch (German)</SelectItem>
                        <SelectItem value="ar">العربية (Arabic)</SelectItem>
                        <SelectItem value="zh">中文 (Mandarin)</SelectItem>
                        <SelectItem value="yue">粵語 (Cantonese)</SelectItem>
                        <SelectItem value="ko">한국어 (Korean)</SelectItem>
                      </SelectContent>
                    </Select>
                  </div>
                  <div>
                    <Label>{t('admin.licenses.instituteLogo')}</Label>
                    <div className="flex items-center gap-3 mt-1">
                      {logoPreview ? (
                        <div className="relative">
                          <img
                            src={logoPreview}
                            alt="Logo preview"
                            className="w-16 h-16 rounded-lg object-cover border"
                          />
                          <button
                            type="button"
                            onClick={clearLogo}
                            className="absolute -top-2 -right-2 bg-destructive text-destructive-foreground rounded-full p-0.5"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          onClick={() => logoInputRef.current?.click()}
                        >
                          <Upload className="w-4 h-4 me-2" />
                          {t('admin.licenses.uploadLogo')}
                        </Button>
                      )}
                      <input
                        ref={logoInputRef}
                        type="file"
                        accept="image/*"
                        onChange={handleLogoChange}
                        className="hidden"
                      />
                    </div>
                  </div>
                </div>
              </div>

              <Separator />
            </>
          )}

          {/* License Info */}
          <div>
            <h3 className="text-sm font-semibold mb-3">{t('admin.licenses.licenseInfo')}</h3>
            <div className="space-y-3">
              <div>
                <Label htmlFor="licenseName">{t('admin.licenses.licenseName')}</Label>
                <Input
                  id="licenseName"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('admin.licenses.licenseNamePlaceholder')}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>{t('admin.licenses.licenseType')}</Label>
                  <Select value={licenseType} onValueChange={setLicenseType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="standard">{t('admin.licenses.standard')}</SelectItem>
                      <SelectItem value="premium">{t('admin.licenses.premium')}</SelectItem>
                      <SelectItem value="enterprise">{t('admin.licenses.enterprise')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label>{t('admin.licenses.subscriptionType')}</Label>
                  <Select value={subscriptionType} onValueChange={setSubscriptionType}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="monthly">{t('admin.licenses.monthly')}</SelectItem>
                      <SelectItem value="yearly">{t('admin.licenses.yearly')}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            {/* Trial */}
            <div className="flex items-center justify-between mt-3">
              <div className="flex items-center gap-2">
                <Switch checked={isTrial} onCheckedChange={setIsTrial} />
                <Label>{t('admin.licenses.isTrial')}</Label>
              </div>
              {isTrial && (
                <div className="flex items-center gap-2">
                  <Label>{t('admin.licenses.trialExpiresAt')}</Label>
                  <Input
                    type="date"
                    className="w-44"
                    value={trialExpiresAt}
                    onChange={(e) => setTrialExpiresAt(e.target.value)}
                  />
                </div>
              )}
            </div>
          </div>

          <Separator />

          {/* Permissions */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold">{t('admin.licenses.permissions')}</h3>
              <div className="flex items-center gap-2">
                <Switch checked={grantAll} onCheckedChange={setGrantAll} />
                <span className="text-sm text-muted-foreground">
                  {t('admin.licenses.grantAll')}
                </span>
              </div>
            </div>

            {!grantAll && (
              <div className="space-y-4">
                {/* Max Students */}
                <div className="flex items-center justify-between">
                  <Label>{t('admin.licenses.maxStudents')}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      className="w-20"
                      value={maxStudents}
                      onChange={(e) => setMaxStudents(parseInt(e.target.value) || 0)}
                      disabled={maxStudentsUnlimited}
                    />
                    <div className="flex items-center gap-1.5">
                      <Checkbox
                        id="maxStudentsUnlimited"
                        checked={maxStudentsUnlimited}
                        onCheckedChange={(v) => setMaxStudentsUnlimited(!!v)}
                      />
                      <label htmlFor="maxStudentsUnlimited" className="text-xs text-muted-foreground cursor-pointer">
                        {t('admin.licenses.unlimited')}
                      </label>
                    </div>
                  </div>
                </div>

                {/* Toggles */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <Label className="text-sm">{t('admin.licenses.aacEnabled')}</Label>
                    <Switch checked={aacEnabled} onCheckedChange={setAacEnabled} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <Label className="text-sm">{t('admin.licenses.boardMakerEnabled')}</Label>
                    <Switch checked={boardMakerEnabled} onCheckedChange={setBoardMakerEnabled} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <Label className="text-sm">{t('admin.licenses.customAppsEnabled')}</Label>
                    <Switch checked={customAppsEnabled} onCheckedChange={setCustomAppsEnabled} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <Label className="text-sm">{t('admin.licenses.unrestrictedAI')}</Label>
                    <Switch checked={unrestrictedAI} onCheckedChange={setUnrestrictedAI} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <Label className="text-sm">{t('admin.licenses.calendar')}</Label>
                    <Switch checked={calendar} onCheckedChange={setCalendar} />
                  </div>
                  <div className="flex items-center justify-between rounded-md border p-3">
                    <Label className="text-sm">{t('admin.licenses.deepAnalysisEnabled')}</Label>
                    <Switch checked={deepAnalysisEnabled} onCheckedChange={setDeepAnalysisEnabled} />
                  </div>
                </div>

                {/* Dashboard Level */}
                <div className="flex items-center justify-between">
                  <Label>{t('admin.licenses.dashboardLevel')}</Label>
                  <Select value={dashboardLevel} onValueChange={setDashboardLevel}>
                    <SelectTrigger className="w-48">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {DASHBOARD_LEVELS.map((dl) => (
                        <SelectItem key={dl.value} value={dl.value}>{dl.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Expert Agents */}
                <div className="flex items-center justify-between">
                  <Label>{t('admin.licenses.expertAgents')}</Label>
                  <div className="flex items-center gap-2">
                    <Input
                      type="number"
                      min={0}
                      className="w-20"
                      value={expertAgentsCount}
                      onChange={(e) => setExpertAgentsCount(parseInt(e.target.value) || 0)}
                      disabled={expertAgentsUnlimited}
                    />
                    <div className="flex items-center gap-1.5">
                      <Checkbox
                        id="expertAgentsUnlimited"
                        checked={expertAgentsUnlimited}
                        onCheckedChange={(v) => setExpertAgentsUnlimited(!!v)}
                      />
                      <label htmlFor="expertAgentsUnlimited" className="text-xs text-muted-foreground cursor-pointer">
                        {t('admin.licenses.unlimited')}
                      </label>
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={isSubmitting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting}>
            {isSubmitting && <Loader2 className="w-4 h-4 me-2 animate-spin" />}
            {isEdit ? t('common.update') : t('common.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
