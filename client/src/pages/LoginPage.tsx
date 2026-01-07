// src/pages/LoginPage.tsx
// Unified Login/Registration page that also handles invite-based signups

import { useState, FormEvent } from 'react';
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
  LogIn, 
  Loader2, 
  UserPlus, 
  Building2, 
  School, 
  Hospital, 
  CheckCircle,
  XCircle,
} from 'lucide-react';

// Types
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

type UserType = 'admin' | 'Teacher' | 'Caregiver' | 'SLP' | 'Parent';

// Google icon SVG component
function GoogleIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24">
      <path
        fill="currentColor"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="currentColor"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="currentColor"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="currentColor"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

// Page layout wrapper
function AuthPageLayout({ 
  children, 
  direction 
}: { 
  children: React.ReactNode;
  direction: 'ltr' | 'rtl';
}) {
  const { language } = useLanguage();
  
  return (
    <div 
      className="min-h-screen flex flex-col bg-gradient-to-br from-background to-muted"
      dir={direction}
    >
      <header className="p-4 flex justify-end">
        <LanguageSelector />
      </header>

      <main className="flex-1 flex items-center justify-center p-4">
        {children}
      </main>

      <footer className="p-4 text-center text-sm text-muted-foreground">
        <a href="/terms-of-service" className="hover:underline">
          {language === 'he' ? 'תנאי שימוש' : 'Terms of Service'}
        </a>
      </footer>
    </div>
  );
}

// Props for when used as invite page
interface LoginPageProps {
  inviteToken?: string;
}

export default function LoginPage({ inviteToken: propToken }: LoginPageProps = {}) {
  // Get token from URL params if not passed as prop (for /invite/:token route)
  const params = useParams<{ token?: string }>();
  const inviteToken = propToken || params.token;
  const isInviteMode = !!inviteToken;
  
  const { isAuthenticated, isLoading: authLoading, login, refetchUser } = useAuth();
  const { t, language, direction } = useLanguage();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  
  // View state
  const [showRegister, setShowRegister] = useState(isInviteMode);
  
  // Login form state
  const [loginData, setLoginData] = useState({ email: '', password: '' });
  const [isLoggingIn, setIsLoggingIn] = useState(false);
  
  // Registration form state
  const [registerData, setRegisterData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
    userType: 'Caregiver' as UserType,
  });
  const [isRegistering, setIsRegistering] = useState(false);
  
  // Invite acceptance state
  const [isAcceptingInvite, setIsAcceptingInvite] = useState(false);

  // Fetch invite details if in invite mode
  const { 
    data: inviteData, 
    isLoading: inviteLoading, 
    error: inviteError 
  } = useQuery({
    queryKey: ['/api/invites/token', inviteToken],
    queryFn: async () => {
      const response = await apiRequest('GET', `/api/invites/token/${inviteToken}`);
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
    enabled: isInviteMode,
    retry: false,
  });

  // User type options with translations
  const userTypeOptions = [
    { value: 'Caregiver', label: language === 'he' ? 'מטפל/ת' : 'Caregiver' },
    { value: 'Guardian', label: language === 'he' ? 'הורה/אפוטרופוס' : 'Parent/Guardian' },
    { value: 'Teacher', label: language === 'he' ? 'מורה' : 'Teacher' },
    { value: 'SLP', label: language === 'he' ? 'קלינאי תקשורת' : 'SLP' },
    { value: 'PPT', label: language === 'he' ? 'פיזיותרפיסט/ית' : 'PPT' },
  ];

  // Handlers
  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    
    if (!loginData.email.trim() || !loginData.password.trim()) {
      toast({ 
        title: t('auth.error'), 
        description: t('auth.fieldsRequired'), 
        variant: 'destructive' 
      });
      return;
    }

    setIsLoggingIn(true);

    try {
      const success = await login(loginData.email, loginData.password);
      if (success) {
        await refetchUser();
        toast({ 
          title: t('auth.loginSuccess'), 
          description: t('auth.welcomeBack') 
        });
        // If we have an invite token, the user will be redirected back here 
        // and can accept it as an authenticated user
        if (isInviteMode) {
          // Page will re-render and show accept invite UI
        } else {
          setLocation('/');
        }
      } else {
        toast({ 
          title: t('auth.loginFailed'), 
          description: t('auth.invalidCredentials'), 
          variant: 'destructive' 
        });
      }
    } catch {
      toast({ 
        title: t('auth.loginFailed'), 
        description: t('auth.loginError'), 
        variant: 'destructive' 
      });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleGoogleLogin = () => {
    // Store invite token in session storage so we can handle it after OAuth callback
    if (inviteToken) {
      sessionStorage.setItem('pendingInviteToken', inviteToken);
    }
    window.location.href = '/auth/google';
  };

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    const d = registerData;

    // Validation
    const emailToUse = isInviteMode && inviteData ? inviteData.invite.email : d.email;
    
    if (!d.firstName.trim() || !d.password.trim() || !d.confirmPassword.trim()) {
      toast({ 
        title: t('auth.error'), 
        description: t('auth.fieldsRequired'), 
        variant: 'destructive' 
      });
      return;
    }

    if (!isInviteMode && !d.email.trim()) {
      toast({ 
        title: t('auth.error'), 
        description: t('auth.fieldsRequired'), 
        variant: 'destructive' 
      });
      return;
    }

    if (d.password !== d.confirmPassword) {
      toast({ 
        title: t('auth.error'), 
        description: t('auth.passwordMismatch'), 
        variant: 'destructive' 
      });
      return;
    }

    if (d.password.length < 6) {
      toast({
        title: t('auth.error'),
        description: t('auth.passwordTooShort') || 'Password must be at least 6 characters',
        variant: 'destructive',
      });
      return;
    }

    setIsRegistering(true);

    try {
      let response;
      
      if (isInviteMode) {
        // Register via invite
        response = await apiRequest('POST', `/api/invites/token/${inviteToken}/register`, {
          firstName: d.firstName,
          lastName: d.lastName,
          password: d.password,
          userType: d.userType,
        });
      } else {
        // Regular registration
        response = await apiRequest('POST', '/auth/register', {
          email: d.email,
          firstName: d.firstName,
          lastName: d.lastName,
          password: d.password,
          userType: d.userType,
        });
      }

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Registration failed');
      }

      await refetchUser();
      
      if (isInviteMode && inviteData) {
        toast({ 
          title: t('invite.registered') || 'Welcome!',
          description: (t('invite.registeredDesc') || `Your account has been created and you've joined ${inviteData.institute.name}`)
        });
      } else {
        toast({ 
          title: t('auth.registerSuccess'), 
          description: t('auth.registerSuccessDesc') 
        });
      }
      
      setLocation('/');
      
    } catch (error: any) {
      toast({ 
        title: t('auth.registerFailed'), 
        description: error.message || t('auth.registerError'), 
        variant: 'destructive' 
      });
    } finally {
      setIsRegistering(false);
    }
  };

  const handleAcceptInvite = async () => {
    setIsAcceptingInvite(true);
    try {
      const response = await apiRequest('POST', `/api/invites/token/${inviteToken}/accept`);
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Failed to accept invite');
      }

      toast({
        title: t('invite.accepted') || 'Invite Accepted',
        description: (t('invite.acceptedDesc') || `You have joined ${inviteData?.institute.name}`),
      });

      setLocation('/');
    } catch (error: any) {
      toast({
        title: t('invite.error') || 'Error',
        description: error.message,
        variant: 'destructive',
      });
    } finally {
      setIsAcceptingInvite(false);
    }
  };

  // Loading state
  if (authLoading || (isInviteMode && inviteLoading)) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  // Invalid invite error state
  if (isInviteMode && (inviteError || !inviteData)) {
    return (
      <AuthPageLayout direction={direction}>
        <Card className="w-full max-w-md shadow-lg">
          <CardHeader className="space-y-1 text-center">
            <div className="mx-auto w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center mb-4">
              <XCircle className="w-6 h-6 text-destructive" />
            </div>
            <CardTitle className="text-2xl font-bold">
              {t('invite.invalid') || 'Invalid Invite'}
            </CardTitle>
            <CardDescription>
              {(inviteError as any)?.message || t('invite.invalidDesc') || 'This invite link is invalid or has expired.'}
            </CardDescription>
          </CardHeader>
          <CardFooter className="flex justify-center">
            <Button onClick={() => setLocation('/login')}>
              <LogIn className="w-4 h-4 me-2" />
              {t('auth.login') || 'Go to Login'}
            </Button>
          </CardFooter>
        </Card>
      </AuthPageLayout>
    );
  }

  // Authenticated user with invite - show accept invite UI
  if (isInviteMode && isAuthenticated && inviteData) {
    const { invite, institute, invitedBy } = inviteData;
    
    return (
      <AuthPageLayout direction={direction}>
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
              disabled={isAcceptingInvite}
            >
              {isAcceptingInvite ? (
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
      </AuthPageLayout>
    );
  }

  // Main login/register view
  return (
    <AuthPageLayout direction={direction}>
      <Card className="w-full max-w-md shadow-lg">
        {!showRegister ? (
          // Login Form
          <>
            <CardHeader className="space-y-1 text-center">
              <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                <LogIn className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="text-2xl font-bold">
                {t('auth.loginTitle')}
              </CardTitle>
              <CardDescription>
                {t('auth.loginSubtitle')}
              </CardDescription>
            </CardHeader>

            <form onSubmit={handleLogin}>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="email">{t('auth.email')}</Label>
                  <Input
                    id="email"
                    type="email"
                    value={loginData.email}
                    onChange={(e) => setLoginData(prev => ({ ...prev, email: e.target.value }))}
                    placeholder={t('auth.emailPlaceholder')}
                    required
                    dir="ltr"
                    disabled={isLoggingIn}
                    data-testid="input-email"
                  />
                </div>

                <div className="space-y-2">
                  <Label htmlFor="password">{t('auth.password')}</Label>
                  <Input
                    id="password"
                    type="password"
                    value={loginData.password}
                    onChange={(e) => setLoginData(prev => ({ ...prev, password: e.target.value }))}
                    placeholder={t('auth.passwordPlaceholder')}
                    required
                    dir="ltr"
                    disabled={isLoggingIn}
                    data-testid="input-password"
                  />
                </div>

                <Button 
                  type="submit" 
                  className="w-full" 
                  disabled={isLoggingIn}
                  data-testid="button-login"
                >
                  {isLoggingIn ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin me-2" />
                      {t('auth.loggingIn')}
                    </>
                  ) : (
                    t('auth.loginButton')
                  )}
                </Button>

                {/* Divider */}
                <div className="relative">
                  <div className="absolute inset-0 flex items-center">
                    <span className="w-full border-t" />
                  </div>
                  <div className="relative flex justify-center text-xs uppercase">
                    <span className="bg-background px-2 text-muted-foreground">
                      {t('auth.or')}
                    </span>
                  </div>
                </div>

                {/* Google Login Button */}
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={handleGoogleLogin}
                  type="button"
                  data-testid="button-google-login"
                >
                  <GoogleIcon className="w-4 h-4 me-2" />
                  {t('auth.googleLogin')}
                </Button>
              </CardContent>

              <CardFooter className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => setShowRegister(true)}
                  className="text-sm text-primary hover:underline"
                >
                  {t('auth.noAccount')}
                </button>

                <button
                  type="button"
                  className="text-sm text-muted-foreground hover:text-primary hover:underline"
                  onClick={() => setLocation('/forgot-password')}
                >
                  {t('auth.forgotPassword')}
                </button>
              </CardFooter>
            </form>
          </>
        ) : (
          // Registration Form
          <>
            <CardHeader className="space-y-1 text-center">
              {isInviteMode && inviteData ? (
                // Invite mode header
                <>
                  <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                    {inviteData.institute.type === 'hospital' ? (
                      <Hospital className="w-8 h-8 text-primary" />
                    ) : (
                      <School className="w-8 h-8 text-primary" />
                    )}
                  </div>
                  <CardTitle className="text-2xl font-bold">
                    {t('invite.createAccount') || 'Create Your Account'}
                  </CardTitle>
                  <CardDescription>
                    {inviteData.invitedBy?.fullName 
                      ? (t('invite.invitedByToJoin') || '{name} invited you to join {institute}')
                          .replace('{name}', inviteData.invitedBy.fullName)
                          .replace('{institute}', inviteData.institute.name)
                      : (t('invite.invitedToJoinInstitute') || 'You have been invited to join {institute}')
                          .replace('{institute}', inviteData.institute.name)
                    }
                  </CardDescription>
                </>
              ) : (
                // Regular registration header
                <>
                  <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                    <UserPlus className="w-6 h-6 text-primary" />
                  </div>
                  <CardTitle className="text-2xl font-bold">
                    {t('auth.registerTitle')}
                  </CardTitle>
                  <CardDescription>
                    {language === 'he' 
                      ? 'צור חשבון חדש כדי להתחיל להשתמש במערכת' 
                      : 'Create a new account to start using the system'}
                  </CardDescription>
                </>
              )}
            </CardHeader>

            <form onSubmit={handleRegister}>
              <CardContent className="space-y-4">
                {/* Institute Info for invite mode */}
                {isInviteMode && inviteData && (
                  <div className="bg-muted rounded-lg p-3 flex items-center gap-3">
                    <Building2 className="w-5 h-5 text-muted-foreground" />
                    <div>
                      <p className="font-medium text-sm">{inviteData.institute.name}</p>
                      <p className="text-xs text-muted-foreground">
                        {t('invite.joiningAs') || 'Joining as'}: {inviteData.invite.role}
                      </p>
                    </div>
                  </div>
                )}

                {/* Email field - pre-filled and disabled for invite mode */}
                {isInviteMode && inviteData ? (
                  <div className="space-y-2">
                    <Label htmlFor="regEmail">{t('auth.email') || 'Email'}</Label>
                    <Input
                      id="regEmail"
                      type="email"
                      value={inviteData.invite.email}
                      disabled
                      dir="ltr"
                      className="bg-muted"
                    />
                  </div>
                ) : (
                  <div className="space-y-2">
                    <Label htmlFor="regEmail">{t('auth.email')}</Label>
                    <Input
                      id="regEmail"
                      type="email"
                      value={registerData.email}
                      onChange={(e) => setRegisterData(prev => ({ ...prev, email: e.target.value }))}
                      placeholder={t('auth.emailPlaceholder')}
                      required
                      dir="ltr"
                      disabled={isRegistering}
                    />
                  </div>
                )}

                {/* Name fields */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <Label htmlFor="firstName">
                      {t('auth.firstName') || 'First Name'} {isInviteMode && '*'}
                    </Label>
                    <Input
                      id="firstName"
                      type="text"
                      value={registerData.firstName}
                      onChange={(e) => setRegisterData(prev => ({ ...prev, firstName: e.target.value }))}
                      placeholder={t('auth.firstNamePlaceholder')}
                      required
                      disabled={isRegistering}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="lastName">{t('auth.lastName')}</Label>
                    <Input
                      id="lastName"
                      type="text"
                      value={registerData.lastName}
                      onChange={(e) => setRegisterData(prev => ({ ...prev, lastName: e.target.value }))}
                      placeholder={t('auth.lastNamePlaceholder')}
                      required={!isInviteMode}
                      disabled={isRegistering}
                    />
                  </div>
                </div>

                {/* User Type */}
                <div className="space-y-2">
                  <Label htmlFor="userType">
                    {language === 'he' ? 'סוג משתמש' : 'User Type'}
                  </Label>
                  <Select
                    value={registerData.userType}
                    onValueChange={(value) => setRegisterData(prev => ({ 
                      ...prev, 
                      userType: value as UserType 
                    }))}
                    disabled={isRegistering}
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
                  <Label htmlFor="regPassword">
                    {t('auth.password')} {isInviteMode && '*'}
                  </Label>
                  <Input
                    id="regPassword"
                    type="password"
                    value={registerData.password}
                    onChange={(e) => setRegisterData(prev => ({ ...prev, password: e.target.value }))}
                    placeholder={t('auth.passwordPlaceholder')}
                    required
                    dir="ltr"
                    disabled={isRegistering}
                  />
                </div>

                {/* Confirm Password */}
                <div className="space-y-2">
                  <Label htmlFor="confirmPassword">
                    {t('auth.confirmPassword')} {isInviteMode && '*'}
                  </Label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    value={registerData.confirmPassword}
                    onChange={(e) => setRegisterData(prev => ({ ...prev, confirmPassword: e.target.value }))}
                    placeholder={t('auth.confirmPasswordPlaceholder')}
                    required
                    dir="ltr"
                    disabled={isRegistering}
                  />
                </div>

                <Button 
                  type="submit" 
                  className="w-full" 
                  disabled={isRegistering}
                  data-testid="button-register"
                >
                  {isRegistering ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin me-2" />
                      {t('auth.registering')}
                    </>
                  ) : isInviteMode ? (
                    <>
                      <UserPlus className="w-4 h-4 me-2" />
                      {t('invite.createAndJoin') || 'Create Account & Join'}
                    </>
                  ) : (
                    t('auth.registerButton')
                  )}
                </Button>

                {/* Divider - only show for non-invite mode */}
                {!isInviteMode && (
                  <>
                    <div className="relative">
                      <div className="absolute inset-0 flex items-center">
                        <span className="w-full border-t" />
                      </div>
                      <div className="relative flex justify-center text-xs uppercase">
                        <span className="bg-background px-2 text-muted-foreground">
                          {t('auth.or')}
                        </span>
                      </div>
                    </div>

                    {/* Google Login Button */}
                    <Button
                      variant="outline"
                      className="w-full"
                      onClick={handleGoogleLogin}
                      type="button"
                      data-testid="button-google-register"
                    >
                      <GoogleIcon className="w-4 h-4 me-2" />
                      {t('auth.googleLogin')}
                    </Button>
                  </>
                )}
              </CardContent>

              <CardFooter className="flex flex-col gap-3">
                {isInviteMode ? (
                  <>
                    <div className="text-sm text-center text-muted-foreground">
                      {t('auth.hasAccount') || 'Already have an account?'}
                    </div>
                    <Button 
                      variant="outline" 
                      className="w-full" 
                      onClick={() => setShowRegister(false)}
                      type="button"
                    >
                      <LogIn className="w-4 h-4 me-2" />
                      {t('auth.login') || 'Log In'}
                    </Button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={() => setShowRegister(false)}
                    className="text-sm text-primary hover:underline"
                  >
                    {t('auth.backToLogin')}
                  </button>
                )}
              </CardFooter>
            </form>
          </>
        )}
      </Card>
    </AuthPageLayout>
  );
}