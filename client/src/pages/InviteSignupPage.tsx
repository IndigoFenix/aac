// src/pages/InviteSignupPage.tsx
// Page for signing up via an invite link

import { useState, useEffect, FormEvent } from 'react';
import { useLocation, useParams } from 'wouter';
import { useQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/useAuth';
import { useLanguage } from '@/contexts/LanguageContext';
import { LanguageSelector } from '@/components/LanguageSelector';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { 
  Loader2, 
  UserPlus, 
  Building2, 
  School, 
  Hospital, 
  CheckCircle,
  XCircle,
  Clock,
  LogIn,
} from 'lucide-react';

interface InviteData {
  id: string;
  email: string;
  role: string;
  grantAdmin: boolean;
  message?: string;
  expiresAt: string;
}

interface InstituteData {
  id: string;
  name: string;
  type: 'school' | 'hospital';
  logoUrl?: string;
}

interface InviterData {
  fullName?: string;
}

export default function InviteSignupPage() {
  const { token } = useParams<{ token: string }>();
  const { isAuthenticated, isLoading: authLoading, refetchUser } = useAuth();
  const { t, language, direction } = useLanguage();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Form state
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    password: '',
    confirmPassword: '',
    userType: 'Caregiver' as 'Caregiver' | 'Teacher' | 'SLP' | 'Parent',
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Fetch invite details
  const { data: inviteData, isLoading, error } = useQuery({
    queryKey: ['/api/invites/token', token],
    queryFn: async () => {
      const response = await apiRequest('GET', `/api/invites/token/${token}`);
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.message || 'Failed to load invite');
      }
      return data as {
        invite: InviteData;
        institute: InstituteData;
        invitedBy: InviterData | null;
      };
    },
    enabled: !!token,
    retry: false,
  });

  // Handle accepting invite for logged-in users
  const handleAcceptInvite = async () => {
    setIsSubmitting(true);
    try {
      const response = await apiRequest('POST', `/api/invites/token/${token}/accept`);
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Failed to accept invite');
      }

      toast({
        title: t('invite.accepted') || 'Invite Accepted',
        description: t('invite.acceptedDesc') || `You have joined ${inviteData?.institute.name}`,
      });

      setLocation('/home');
    } catch (error: any) {
      toast({
        title: t('invite.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // Handle registration with invite
  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();

    if (!formData.firstName.trim() || !formData.password.trim()) {
      toast({
        title: t('auth.error') || 'Error',
        description: t('auth.fieldsRequired') || 'Please fill in all required fields',
        variant: 'destructive',
      });
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      toast({
        title: t('auth.error') || 'Error',
        description: t('auth.passwordMismatch') || 'Passwords do not match',
        variant: 'destructive',
      });
      return;
    }

    if (formData.password.length < 6) {
      toast({
        title: t('auth.error') || 'Error',
        description: t('auth.passwordTooShort') || 'Password must be at least 6 characters',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await apiRequest('POST', `/api/invites/token/${token}/register`, {
        firstName: formData.firstName,
        lastName: formData.lastName,
        password: formData.password,
        userType: formData.userType,
      });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Registration failed');
      }

      await refetchUser();
      
      toast({
        title: t('invite.registered') || 'Welcome!',
        description: t('invite.registeredDesc') || `Your account has been created and you've joined ${inviteData?.institute.name}`,
      });

      setLocation('/home');
    } catch (error: any) {
      toast({
        title: t('auth.registerFailed') || 'Registration Failed',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  // User type options
  const userTypeOptions = [
    { value: 'Caregiver', label: language === 'he' ? 'מטפל/ת' : 'Caregiver' },
    { value: 'Parent', label: language === 'he' ? 'הורה' : 'Parent' },
    { value: 'Teacher', label: language === 'he' ? 'מורה' : 'Teacher' },
    { value: 'SLP', label: language === 'he' ? 'קלינאי תקשורת' : 'SLP' },
  ];

  if (authLoading || isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Error state
  if (error || !inviteData) {
    return (
      <div
        className="min-h-screen flex flex-col bg-gradient-to-br from-background to-muted"
        dir={direction}
      >
        <header className="p-4 flex justify-end">
          <LanguageSelector />
        </header>

        <main className="flex-1 flex items-center justify-center p-4">
          <Card className="w-full max-w-md shadow-lg">
            <CardHeader className="space-y-1 text-center">
              <div className="mx-auto w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center mb-4">
                <XCircle className="w-6 h-6 text-destructive" />
              </div>
              <CardTitle className="text-2xl font-bold">
                {t('invite.invalid') || 'Invalid Invite'}
              </CardTitle>
              <CardDescription>
                {(error as any)?.message || t('invite.invalidDesc') || 'This invite link is invalid or has expired.'}
              </CardDescription>
            </CardHeader>
            <CardFooter className="flex justify-center">
              <Button onClick={() => setLocation('/login')}>
                <LogIn className="w-4 h-4 me-2" />
                {t('auth.login') || 'Go to Login'}
              </Button>
            </CardFooter>
          </Card>
        </main>
      </div>
    );
  }

  const { invite, institute, invitedBy } = inviteData;

  // Logged in user - show accept invite UI
  if (isAuthenticated) {
    return (
      <div
        className="min-h-screen flex flex-col bg-gradient-to-br from-background to-muted"
        dir={direction}
      >
        <header className="p-4 flex justify-end">
          <LanguageSelector />
        </header>

        <main className="flex-1 flex items-center justify-center p-4">
          <Card className="w-full max-w-md shadow-lg">
            <CardHeader className="space-y-1 text-center">
              <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                {institute.type === 'hospital' ? (
                  <Hospital className="w-8 h-8 text-primary" />
                ) : (
                  <School className="w-8 h-8 text-primary" />
                )}
              </div>
              <CardTitle className="text-2xl font-bold">
                {t('invite.joinTitle') || 'Join Institute'}
              </CardTitle>
              <CardDescription>
                {invitedBy?.fullName 
                  ? (t('invite.invitedBy') || 'You have been invited by {name}').replace('{name}', invitedBy.fullName)
                  : (t('invite.invitedToJoin') || 'You have been invited to join')
                }
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              {/* Institute Info */}
              <div className="bg-muted rounded-lg p-4 text-center">
                <h3 className="text-lg font-semibold">{institute.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {t(`institute.type.${institute.type}`) || institute.type}
                </p>
              </div>

              {/* Role Info */}
              <div className="flex items-center justify-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {t('invite.yourRole') || 'Your role:'}
                </span>
                <Badge variant="secondary">{invite.role}</Badge>
                {invite.grantAdmin && (
                  <Badge variant="outline">{t('invite.admin') || 'Admin'}</Badge>
                )}
              </div>

              {/* Message */}
              {invite.message && (
                <div className="bg-muted/50 rounded-lg p-3">
                  <p className="text-sm italic">"{invite.message}"</p>
                </div>
              )}

              <Button
                className="w-full"
                onClick={handleAcceptInvite}
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    {t('invite.accepting') || 'Accepting...'}
                  </>
                ) : (
                  <>
                    <CheckCircle className="w-4 h-4 me-2" />
                    {t('invite.accept') || 'Accept Invite'}
                  </>
                )}
              </Button>
            </CardContent>

            <CardFooter className="flex justify-center">
              <Button variant="ghost" onClick={() => setLocation('/')}>
                {t('common.cancel') || 'Cancel'}
              </Button>
            </CardFooter>
          </Card>
        </main>
      </div>
    );
  }

  // Not logged in - show registration form
  return (
    <div
      className="min-h-screen flex flex-col bg-gradient-to-br from-background to-muted"
      dir={direction}
    >
      <header className="p-4 flex justify-end">
        <LanguageSelector />
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        <Card className="w-full max-w-md shadow-lg">
          <CardHeader className="space-y-1 text-center">
            <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
              {institute.type === 'hospital' ? (
                <Hospital className="w-8 h-8 text-primary" />
              ) : (
                <School className="w-8 h-8 text-primary" />
              )}
            </div>
            <CardTitle className="text-2xl font-bold">
              {t('invite.createAccount') || 'Create Your Account'}
            </CardTitle>
            <CardDescription>
              {invitedBy?.fullName 
                ? (t('invite.invitedByToJoin') || '{name} invited you to join {institute}')
                    .replace('{name}', invitedBy.fullName)
                    .replace('{institute}', institute.name)
                : (t('invite.invitedToJoinInstitute') || 'You have been invited to join {institute}')
                    .replace('{institute}', institute.name)
              }
            </CardDescription>
          </CardHeader>

          <form onSubmit={handleRegister}>
            <CardContent className="space-y-4">
              {/* Institute Info */}
              <div className="bg-muted rounded-lg p-3 flex items-center gap-3">
                <Building2 className="w-5 h-5 text-muted-foreground" />
                <div>
                  <p className="font-medium text-sm">{institute.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {t('invite.joiningAs') || 'Joining as'}: {invite.role}
                  </p>
                </div>
              </div>

              {/* Email (pre-filled, read-only) */}
              <div className="space-y-2">
                <Label htmlFor="email">{t('auth.email') || 'Email'}</Label>
                <Input
                  id="email"
                  type="email"
                  value={invite.email}
                  disabled
                  dir="ltr"
                  className="bg-muted"
                />
              </div>

              {/* Name fields */}
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label htmlFor="firstName">{t('auth.firstName') || 'First Name'} *</Label>
                  <Input
                    id="firstName"
                    type="text"
                    value={formData.firstName}
                    onChange={(e) => setFormData(prev => ({ ...prev, firstName: e.target.value }))}
                    placeholder={t('auth.firstNamePlaceholder') || 'First Name'}
                    required
                    disabled={isSubmitting}
                  />
                </div>
                <div className="space-y-2">
                  <Label htmlFor="lastName">{t('auth.lastName') || 'Last Name'}</Label>
                  <Input
                    id="lastName"
                    type="text"
                    value={formData.lastName}
                    onChange={(e) => setFormData(prev => ({ ...prev, lastName: e.target.value }))}
                    placeholder={t('auth.lastNamePlaceholder') || 'Last Name'}
                    disabled={isSubmitting}
                  />
                </div>
              </div>

              {/* User Type */}
              <div className="space-y-2">
                <Label htmlFor="userType">
                  {language === 'he' ? 'סוג משתמש' : 'User Type'}
                </Label>
                <Select
                  value={formData.userType}
                  onValueChange={(value) => setFormData(prev => ({ 
                    ...prev, 
                    userType: value as typeof formData.userType 
                  }))}
                  disabled={isSubmitting}
                >
                  <SelectTrigger>
                    <SelectValue placeholder={language === 'he' ? 'בחר סוג משתמש' : 'Select user type'} />
                  </SelectTrigger>
                  <SelectContent>
                    {userTypeOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {/* Password */}
              <div className="space-y-2">
                <Label htmlFor="password">{t('auth.password') || 'Password'} *</Label>
                <Input
                  id="password"
                  type="password"
                  value={formData.password}
                  onChange={(e) => setFormData(prev => ({ ...prev, password: e.target.value }))}
                  placeholder={t('auth.passwordPlaceholder') || 'Password'}
                  required
                  dir="ltr"
                  disabled={isSubmitting}
                />
              </div>

              {/* Confirm Password */}
              <div className="space-y-2">
                <Label htmlFor="confirmPassword">{t('auth.confirmPassword') || 'Confirm Password'} *</Label>
                <Input
                  id="confirmPassword"
                  type="password"
                  value={formData.confirmPassword}
                  onChange={(e) => setFormData(prev => ({ ...prev, confirmPassword: e.target.value }))}
                  placeholder={t('auth.confirmPasswordPlaceholder') || 'Confirm Password'}
                  required
                  dir="ltr"
                  disabled={isSubmitting}
                />
              </div>

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    {t('auth.registering') || 'Creating account...'}
                  </>
                ) : (
                  <>
                    <UserPlus className="w-4 h-4 me-2" />
                    {t('invite.createAndJoin') || 'Create Account & Join'}
                  </>
                )}
              </Button>
            </CardContent>
          </form>

          <CardFooter className="flex flex-col gap-3">
            <div className="text-sm text-center text-muted-foreground">
              {t('auth.hasAccount') || 'Already have an account?'}
            </div>
            <Button variant="outline" className="w-full" onClick={() => setLocation('/login')}>
              <LogIn className="w-4 h-4 me-2" />
              {t('auth.login') || 'Log In'}
            </Button>
          </CardFooter>
        </Card>
      </main>

      <footer className="p-4 text-center text-sm text-muted-foreground">
        <a href="/terms-of-service" className="hover:underline">
          {language === 'he' ? 'תנאי שימוש' : 'Terms of Service'}
        </a>
      </footer>
    </div>
  );
}
