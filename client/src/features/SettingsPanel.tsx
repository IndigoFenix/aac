// src/features/student-management/SettingsPanel.tsx
// Settings panel for the application

import { useState, useEffect } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useLanguage } from '@/contexts/LanguageContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useAuth } from '@/hooks/useAuth';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
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
  Palette,
  Languages,
  Building2,
  CloudCog,
  Check,
  Loader2,
  Unlink,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { apiRequest } from '@/lib/queryClient';
import { BiometricEnrollment } from '@/components/BiometricEnrollment';

type SystemType = 'tala' | 'us_iep';

export function SettingsPanel() {
  const { language, setLanguage, isRTL } = useLanguage();
  const { theme, setTheme } = useTheme();
  const { user } = useAuth();
  const queryClient = useQueryClient();

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
                  <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center">
                    {user.profileImageUrl ? (
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
                  <Button variant="outline">{t('settings.editProfile')}</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* Biometric Recognition Section - hidden until feature is ready
          {user && (
            <BiometricEnrollment
              entityType="user"
              entityId={user.id}
            />
          )}
          */}

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
                    <SelectItem value="he">עברית (Hebrew)</SelectItem>
                    <SelectItem value="en">English (אנגלית)</SelectItem>
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
            <p>CliniAACian v1.0.0</p>
            <p className="text-xs mt-1">© 2025 All rights reserved</p>
          </div>
        </div>
      </div>
    </ScrollArea>
  );
}
