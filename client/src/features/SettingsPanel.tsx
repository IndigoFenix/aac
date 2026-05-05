// src/features/student-management/SettingsPanel.tsx
// Settings panel for the application

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useAuth } from '@/hooks/useAuth';
import { useToast } from '@/hooks/use-toast';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Globe,
  Moon,
  Sun,
  Settings2,
  User,
  Bell,
  Shield,
  ShieldCheck,
  ShieldOff,
  Palette,
  Languages,
  Building2,
  CloudCog,
  Check,
  Loader2,
  Unlink,
  Accessibility,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiRequest, apiUrl } from '@/lib/queryClient';
import { useAccessibility } from '@/contexts/AccessibilityContext';
import { Slider } from '@/components/ui/slider';
import { openUI } from '@/lib/uiEvents';

type SystemType = 'tala' | 'us_iep';

export function SettingsPanel() {
  const { language, setLanguage, isRTL } = useLanguage();
  const { theme, setTheme } = useTheme();
  const { user, refetchUser } = useAuth();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const { fontSize, highContrast, reduceAnimations, enhancedFocusIndicator, setFontSize, setHighContrast, setReduceAnimations, setEnhancedFocusIndicator } = useAccessibility();

  // MFA state
  const [mfaSetupStep, setMfaSetupStep] = useState<'idle' | 'setup' | 'verify' | 'disable'>('idle');
  const [mfaQrCode, setMfaQrCode] = useState<string | null>(null);
  const [mfaManualKey, setMfaManualKey] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaDisableCode, setMfaDisableCode] = useState('');

  const mfaSetupMutation = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/auth/mfa/setup');
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setMfaQrCode(data.qrCode);
        setMfaManualKey(data.manualEntryKey);
        setMfaSetupStep('verify');
      } else {
        toast({ title: t('settings.mfaSetupFailed'), description: data.message || t('settings.mfaSetupFailedDesc'), variant: 'destructive' });
      }
    },
    onError: (error: any) => {
      toast({ title: t('settings.mfaSetupFailed'), description: error.message || t('settings.mfaSetupFailedDesc'), variant: 'destructive' });
    },
  });

  const mfaVerifySetupMutation = useMutation({
    mutationFn: async (code: string) => {
      const res = await apiRequest('POST', '/auth/mfa/verify-setup', { code });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setMfaSetupStep('idle');
        setMfaQrCode(null);
        setMfaManualKey(null);
        setMfaCode('');
        queryClient.invalidateQueries({ queryKey: ['/auth/user'] });
        refetchUser();
        toast({ title: t('settings.mfaSetupSuccess'), description: t('settings.mfaEnabledDesc') });
      } else {
        toast({ title: t('settings.mfaVerificationFailed'), description: data.message || t('settings.mfaInvalidCode'), variant: 'destructive' });
      }
    },
    onError: (error: any) => {
      toast({ title: t('settings.mfaVerificationFailed'), description: error.message || t('settings.mfaVerificationFailedDesc'), variant: 'destructive' });
    },
  });

  const mfaDisableMutation = useMutation({
    mutationFn: async (code: string) => {
      const res = await apiRequest('POST', '/auth/mfa/disable', { code });
      return res.json();
    },
    onSuccess: (data) => {
      if (data.success) {
        setMfaSetupStep('idle');
        setMfaDisableCode('');
        queryClient.invalidateQueries({ queryKey: ['/auth/user'] });
        refetchUser();
        toast({ title: t('settings.mfaDisabled'), description: t('settings.mfaDisabledDesc') });
      } else {
        toast({ title: t('settings.mfaDisableFailed'), description: data.message || t('settings.mfaInvalidCode'), variant: 'destructive' });
      }
    },
    onError: (error: any) => {
      toast({ title: t('settings.mfaDisableFailed'), description: error.message || t('settings.mfaDisableFailedDesc'), variant: 'destructive' });
    },
  });

  // System type state (affects workflow and default language)
  const [systemType, setSystemType] = useState<SystemType>('us_iep');

  // Notification settings
  const [notifications, setNotifications] = useState({
    email: true,
    push: false,
    deadlineReminders: true,
    progressUpdates: true,
  });

  // Dropbox connection
  const { data: dropboxStatus, isLoading: isDropboxLoading } = useQuery<{
    connected: boolean;
    email?: string;
    folderPath?: string;
  }>({
    queryKey: ['/api/integrations/dropbox/status'],
    enabled: !!user,
  });

  const connectDropbox = useMutation({
    mutationFn: async () => {
      const res = await apiRequest('POST', '/api/integrations/dropbox/oauth/start');
      const { redirectUrl } = await res.json();
      window.location.href = redirectUrl;
    },
  });

  const disconnectDropbox = useMutation({
    mutationFn: async () => {
      await apiRequest('DELETE', '/api/integrations/dropbox/connection');
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['/api/integrations/dropbox/status'] });
    },
  });

  // Handle system type change
  const handleSystemTypeChange = (value: SystemType) => {
    setSystemType(value);
    // Auto-switch language based on system type
    if (value === 'tala') {
      setLanguage('he');
    } else {
      setLanguage('en');
    }
  };

  const { t } = useLanguage();
  const isDark = theme === 'dark';

  return (
    <ScrollArea className="h-full">
      <div className={cn(
        "p-6",
        isDark ? "bg-background" : "bg-gray-50/50"
      )}>
        <div className="max-w-3xl mx-auto space-y-6">
          
          {/* Header */}
          <div className={isRTL ? "text-right" : ""}>
            <h1 className="text-3xl font-bold text-foreground mb-2">
              {t('settings.title')}
            </h1>
            <p className="text-muted-foreground">{t('settings.subtitle')}</p>
          </div>

          {/* Profile Section */}
          {user && (
            <Card>
              <CardHeader>
                <CardTitle className={cn(
                  "flex items-center gap-2",
                  isRTL && "flex-row-reverse"
                )}>
                  <User className="w-5 h-5" />
                  {t('settings.profile')}
                </CardTitle>
                <CardDescription>{t('settings.profileDesc')}</CardDescription>
              </CardHeader>
              <CardContent>
                <div className={cn(
                  "flex items-center gap-4",
                  isRTL && "flex-row-reverse"
                )}>
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center overflow-hidden">
                    {user.biometricDataId ? (
                      <img
                        src={apiUrl(`/api/biometric-data/${user.biometricDataId}/photo`)}
                        alt={user.fullName || 'Profile'}
                        className="w-full h-full object-cover"
                        onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
                      />
                    ) : user.profileImageUrl ? (
                      <img
                        src={user.profileImageUrl}
                        alt={user.fullName || 'Profile'}
                        className="w-full h-full rounded-full object-cover"
                      />
                    ) : (
                      <User className="w-8 h-8 text-primary" />
                    )}
                  </div>
                  <div className={cn("flex-1", isRTL && "text-right")}>
                    <h3 className="font-semibold text-lg">{user.fullName}</h3>
                    <p className="text-sm text-muted-foreground">{user.email}</p>
                    <Badge variant="secondary" className="mt-1">
                      {user.userType}
                    </Badge>
                  </div>
                  <Button variant="outline" onClick={() => openUI('settings')}>
                    {t('settings.editProfile')}
                  </Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* System Settings */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <Building2 className="w-5 h-5" />
                {t('settings.system')}
              </CardTitle>
              <CardDescription>{t('settings.systemDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    {t('settings.workflowSystem')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {systemType === 'tala' 
                      ? t('settings.talaDescription')
                      : t('settings.usIepDescription')
                    }
                  </p>
                </div>
                <Select value={systemType} onValueChange={handleSystemTypeChange}>
                  <SelectTrigger className="w-[220px]">
                    <SelectValue placeholder="Select System" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="tala">
                      <div className={cn("flex items-center gap-2", isRTL && "flex-row-reverse")}>
                        <span>🇮🇱</span>
                        <span>{t('settings.systemTala')}</span>
                      </div>
                    </SelectItem>
                    <SelectItem value="us_iep">
                      <div className={cn("flex items-center gap-2", isRTL && "flex-row-reverse")}>
                        <span>🇺🇸</span>
                        <span>{t('settings.systemUs')}</span>
                      </div>
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </CardContent>
          </Card>

          {/* Language Settings */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <Languages className="w-5 h-5" />
                {t('settings.language')}
              </CardTitle>
              <CardDescription>{t('settings.languageDesc')}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    {t('settings.displayLanguage')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.displayLanguageDesc')}
                  </p>
                </div>
                <Select value={language} onValueChange={(val) => setLanguage(val as 'he' | 'en')}>
                  <SelectTrigger className="w-[180px]">
                    <Globe className="w-4 h-4 mr-2" />
                    <SelectValue placeholder="Select Language" />
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
            </CardContent>
          </Card>

          {/* Appearance */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <Palette className="w-5 h-5" />
                {t('settings.appearance')}
              </CardTitle>
              <CardDescription>{t('settings.appearanceDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn(
                  "flex items-center gap-3",
                  isRTL && "flex-row-reverse"
                )}>
                  {theme === "dark" ? (
                    <Moon className="w-5 h-5 text-foreground" />
                  ) : (
                    <Sun className="w-5 h-5 text-foreground" />
                  )}
                  <div className={cn("space-y-0.5", isRTL && "text-right")}>
                    <Label className="text-base font-medium">
                      {t('settings.darkMode')}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.darkModeDesc')}
                    </p>
                  </div>
                </div>
                <Switch
                  checked={theme === "dark"}
                  onCheckedChange={(checked) => setTheme(checked ? "dark" : "light")}
                />
              </div>
            </CardContent>
          </Card>

          {/* Accessibility */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <Accessibility className="w-5 h-5" />
                {t('settings.accessibility')}
              </CardTitle>
              <CardDescription>{t('settings.accessibilityDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-6">
              {/* Font Size */}
              <div className="space-y-3">
                <div className={cn(
                  "flex items-center justify-between",
                  isRTL && "flex-row-reverse"
                )}>
                  <div className={cn("space-y-0.5", isRTL && "text-right")}>
                    <Label className="text-base font-medium">
                      {t('settings.fontSize')}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.fontSizeDesc')}
                    </p>
                  </div>
                  <span className="text-sm text-muted-foreground font-medium">{fontSize}%</span>
                </div>
                <Slider
                  min={75}
                  max={200}
                  step={25}
                  value={[fontSize]}
                  onValueChange={(v) => setFontSize(v[0])}
                  className="w-full"
                />
              </div>

              <Separator />

              {/* High Contrast */}
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    {t('settings.contrastMode')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.contrastModeDesc')}
                  </p>
                </div>
                <Switch
                  checked={highContrast}
                  onCheckedChange={setHighContrast}
                />
              </div>

              <Separator />

              {/* Reduce Animations */}
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    {t('settings.reduceAnimations')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.reduceAnimationsDesc')}
                  </p>
                </div>
                <Switch
                  checked={reduceAnimations}
                  onCheckedChange={setReduceAnimations}
                />
              </div>

              <Separator />

              {/* Enhanced Focus Indicator */}
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    {t('settings.enhancedFocus')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.enhancedFocusDesc')}
                  </p>
                </div>
                <Switch
                  checked={enhancedFocusIndicator}
                  onCheckedChange={setEnhancedFocusIndicator}
                />
              </div>
            </CardContent>
          </Card>

          {/* Notifications */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <Bell className="w-5 h-5" />
                {t('settings.notifications')}
              </CardTitle>
              <CardDescription>{t('settings.notificationsDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    {t('settings.emailNotifications')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.emailNotificationsDesc')}
                  </p>
                </div>
                <Switch
                  checked={notifications.email}
                  onCheckedChange={(checked) => setNotifications(prev => ({ ...prev, email: checked }))}
                />
              </div>
              
              <Separator />
              
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    {t('settings.deadlineReminders')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.deadlineRemindersDesc')}
                  </p>
                </div>
                <Switch
                  checked={notifications.deadlineReminders}
                  onCheckedChange={(checked) => setNotifications(prev => ({ ...prev, deadlineReminders: checked }))}
                />
              </div>
              
              <Separator />
              
              <div className={cn(
                "flex items-center justify-between",
                isRTL && "flex-row-reverse"
              )}>
                <div className={cn("space-y-0.5", isRTL && "text-right")}>
                  <Label className="text-base font-medium">
                    {t('settings.progressUpdates')}
                  </Label>
                  <p className="text-sm text-muted-foreground">
                    {t('settings.progressUpdatesDesc')}
                  </p>
                </div>
                <Switch
                  checked={notifications.progressUpdates}
                  onCheckedChange={(checked) => setNotifications(prev => ({ ...prev, progressUpdates: checked }))}
                />
              </div>
            </CardContent>
          </Card>

          {/* Dropbox Integration */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <CloudCog className="w-5 h-5" />
                {t('settings.dropbox')}
              </CardTitle>
              <CardDescription>{t('settings.dropboxDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {isDropboxLoading ? (
                <div className="flex items-center justify-center py-4">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              ) : dropboxStatus?.connected ? (
                <>
                  <div className={cn(
                    "flex items-center justify-between",
                    isRTL && "flex-row-reverse"
                  )}>
                    <div className={cn("space-y-0.5", isRTL && "text-right")}>
                      <div className={cn(
                        "flex items-center gap-2",
                        isRTL && "flex-row-reverse"
                      )}>
                        <Check className="w-4 h-4 text-emerald-500" />
                        <Label className="text-base font-medium">
                          {t('settings.dropboxConnected')}
                        </Label>
                      </div>
                      <p className="text-sm text-muted-foreground">
                        {dropboxStatus.email}
                      </p>
                      {dropboxStatus.folderPath && (
                        <p className="text-xs text-muted-foreground">
                          {t('settings.dropboxFolder')}: {dropboxStatus.folderPath}
                        </p>
                      )}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => disconnectDropbox.mutate()}
                      disabled={disconnectDropbox.isPending}
                      className="text-destructive hover:text-destructive"
                    >
                      {disconnectDropbox.isPending ? (
                        <Loader2 className="w-4 h-4 animate-spin mr-1" />
                      ) : (
                        <Unlink className="w-4 h-4 mr-1" />
                      )}
                      {t('settings.dropboxDisconnect')}
                    </Button>
                  </div>
                </>
              ) : (
                <div className={cn(
                  "flex items-center justify-between",
                  isRTL && "flex-row-reverse"
                )}>
                  <div className={cn("space-y-0.5", isRTL && "text-right")}>
                    <Label className="text-base font-medium">
                      {t('settings.dropboxNotConnected')}
                    </Label>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.dropboxConnectDesc')}
                    </p>
                  </div>
                  <Button
                    onClick={() => connectDropbox.mutate()}
                    disabled={connectDropbox.isPending}
                  >
                    {connectDropbox.isPending ? (
                      <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    ) : null}
                    {t('settings.dropboxConnect')}
                  </Button>
                </div>
              )}
            </CardContent>
          </Card>

          {/* Security */}
          <Card>
            <CardHeader>
              <CardTitle className={cn(
                "flex items-center gap-2",
                isRTL && "flex-row-reverse"
              )}>
                <Shield className="w-5 h-5" />
                {t('settings.security')}
              </CardTitle>
              <CardDescription>{t('settings.securityDesc')}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Two-Factor Authentication */}
              <div className="space-y-3">
                <div className={cn('flex items-center justify-between', isRTL && 'flex-row-reverse')}>
                  <div className={cn('flex items-center gap-2', isRTL && 'flex-row-reverse')}>
                    {user?.mfaEnabled ? (
                      <>
                        <ShieldCheck className="w-5 h-5 text-green-500" />
                        <Label className="text-base font-medium text-green-600">
                          {t('settings.mfaEnabled')}
                        </Label>
                      </>
                    ) : (
                      <>
                        <ShieldOff className="w-5 h-5 text-muted-foreground" />
                        <Label className="text-base font-medium">
                          {t('settings.mfaNotEnabled')}
                        </Label>
                      </>
                    )}
                  </div>
                  {user?.mfaEnforcedByAdmin && (
                    <Badge variant="outline" className="bg-yellow-50 text-yellow-800 border-yellow-300">
                      {t('settings.mfaRequiredByAdmin')}
                    </Badge>
                  )}
                </div>

                {mfaSetupStep === 'idle' && !user?.mfaEnabled && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {t('settings.mfaDescription')}
                    </p>
                    <Button
                      onClick={() => {
                        setMfaSetupStep('setup');
                        mfaSetupMutation.mutate();
                      }}
                      disabled={mfaSetupMutation.isPending}
                      className="flex items-center gap-2"
                    >
                      {mfaSetupMutation.isPending ? (
                        <><Loader2 className="w-4 h-4 animate-spin" />{t('settings.mfaSettingUp')}</>
                      ) : (
                        <><Shield className="w-4 h-4" />{t('settings.mfaEnable')}</>
                      )}
                    </Button>
                  </>
                )}

                {mfaSetupStep === 'verify' && mfaQrCode && (
                  <div className="space-y-4">
                    <p className="text-sm text-muted-foreground">{t('settings.mfaScanQr')}</p>
                    <div className="flex justify-center">
                      <img src={mfaQrCode} alt="MFA QR Code" className="w-48 h-48 border rounded" />
                    </div>
                    {mfaManualKey && (
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground mb-1">{t('settings.mfaManualKey')}</p>
                        <code className="bg-muted px-2 py-1 rounded text-sm font-mono select-all">
                          {mfaManualKey}
                        </code>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label>{t('settings.mfaEnterCode')}</Label>
                      <div className="flex justify-center">
                        <InputOTP maxLength={6} value={mfaCode} onChange={setMfaCode}>
                          <InputOTPGroup>
                            <InputOTPSlot index={0} />
                            <InputOTPSlot index={1} />
                            <InputOTPSlot index={2} />
                            <InputOTPSlot index={3} />
                            <InputOTPSlot index={4} />
                            <InputOTPSlot index={5} />
                          </InputOTPGroup>
                        </InputOTP>
                      </div>
                    </div>
                    <div className="flex gap-2 justify-center">
                      <Button
                        onClick={() => mfaVerifySetupMutation.mutate(mfaCode)}
                        disabled={mfaCode.length !== 6 || mfaVerifySetupMutation.isPending}
                      >
                        {mfaVerifySetupMutation.isPending ? (
                          <><Loader2 className="w-4 h-4 animate-spin mr-2" />{t('settings.mfaVerifying')}</>
                        ) : (
                          t('settings.mfaVerifyEnable')
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setMfaSetupStep('idle');
                          setMfaQrCode(null);
                          setMfaManualKey(null);
                          setMfaCode('');
                        }}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                )}

                {mfaSetupStep === 'idle' && user?.mfaEnabled && (
                  <>
                    <p className="text-sm text-muted-foreground">{t('settings.mfaProtected')}</p>
                    {!user.mfaEnforcedByAdmin && (
                      <Button variant="destructive" onClick={() => setMfaSetupStep('disable')}>
                        <ShieldOff className="w-4 h-4 mr-2" />
                        {t('settings.mfaDisable')}
                      </Button>
                    )}
                    {user.mfaEnforcedByAdmin && (
                      <p className="text-sm text-yellow-600">{t('settings.mfaAdminLocked')}</p>
                    )}
                  </>
                )}

                {mfaSetupStep === 'disable' && (
                  <div className="space-y-4">
                    <Alert>
                      <AlertDescription>{t('settings.mfaDisableHint')}</AlertDescription>
                    </Alert>
                    <div className="space-y-2">
                      <Label>{t('settings.mfaEnterCode')}</Label>
                      <div className="flex justify-center">
                        <InputOTP maxLength={6} value={mfaDisableCode} onChange={setMfaDisableCode}>
                          <InputOTPGroup>
                            <InputOTPSlot index={0} />
                            <InputOTPSlot index={1} />
                            <InputOTPSlot index={2} />
                            <InputOTPSlot index={3} />
                            <InputOTPSlot index={4} />
                            <InputOTPSlot index={5} />
                          </InputOTPGroup>
                        </InputOTP>
                      </div>
                    </div>
                    <div className="flex gap-2 justify-center">
                      <Button
                        variant="destructive"
                        onClick={() => mfaDisableMutation.mutate(mfaDisableCode)}
                        disabled={mfaDisableCode.length !== 6 || mfaDisableMutation.isPending}
                      >
                        {mfaDisableMutation.isPending ? (
                          <><Loader2 className="w-4 h-4 animate-spin mr-2" />{t('settings.mfaDisabling')}</>
                        ) : (
                          t('settings.mfaConfirmDisable')
                        )}
                      </Button>
                      <Button
                        variant="outline"
                        onClick={() => {
                          setMfaSetupStep('idle');
                          setMfaDisableCode('');
                        }}
                      >
                        {t('common.cancel')}
                      </Button>
                    </div>
                  </div>
                )}
              </div>

              <Separator />

              <Button variant="outline" className="w-full">
                {t('settings.changePassword')}
              </Button>
              <Button variant="outline" className="w-full">
                {t('settings.manageSessions')}
              </Button>
            </CardContent>
          </Card>

          {/* Legal Links */}
          <div className={cn(
            "text-center text-sm text-muted-foreground pt-4 space-y-1",
          )}>
            <div className="flex flex-wrap justify-center gap-x-3 gap-y-1">
              <a href="/terms-of-service" target="_blank" className="hover:underline hover:text-primary transition-colors">
                {isRTL ? 'תנאי שימוש' : 'Terms of Service'}
              </a>
              <a href="/privacy-policy" target="_blank" className="hover:underline hover:text-primary transition-colors">
                {isRTL ? 'מדיניות פרטיות' : 'Privacy Policy'}
              </a>
              <a href="/cookie-policy" target="_blank" className="hover:underline hover:text-primary transition-colors">
                {isRTL ? 'מדיניות עוגיות' : 'Cookie Policy'}
              </a>
              <a href="/accessibility" target="_blank" className="hover:underline hover:text-primary transition-colors">
                {isRTL ? 'הצהרת נגישות' : 'Accessibility'}
              </a>
              <a href="/ai-policy" target="_blank" className="hover:underline hover:text-primary transition-colors">
                {isRTL ? 'מדיניות AI' : 'AI Policy'}
              </a>
            </div>
          </div>

          {/* Version Info */}
          <div className={cn(
            "text-center text-sm text-muted-foreground pt-2",
            isRTL && "text-center"
          )}>
            <p>Aivota v1.0.0</p>
            <p className="text-xs mt-1">© 2026 All rights reserved</p>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
