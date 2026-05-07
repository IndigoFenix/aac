// src/pages/LoginPage.tsx
// Unified Login/Registration page that also handles invite-based signups

import { useState, FormEvent, useEffect } from 'react';
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
  Shield,
  KeyRound,
} from 'lucide-react';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { type LoginResult } from '@/hooks/useAuth';
import { passwordPolicy } from '@shared/schema';
import aivotaLogo from '@assets/aivota_logo.png';

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
  type: 'school' | 'clinic';
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

      <footer className="p-4 text-center text-sm text-muted-foreground space-x-2 rtl:space-x-reverse">
        <a href="/terms-of-service" className="hover:underline">
          {language === 'he' ? 'תנאי שימוש' : 'Terms of Service'}
        </a>
        <span>|</span>
        <a href="/privacy-policy" className="hover:underline">
          {language === 'he' ? 'מדיניות פרטיות' : 'Privacy Policy'}
        </a>
        <span>|</span>
        <a href="/cookie-policy" className="hover:underline">
          {language === 'he' ? 'מדיניות עוגיות' : 'Cookie Policy'}
        </a>
        <span>|</span>
        <a href="/accessibility" className="hover:underline">
          {language === 'he' ? 'הצהרת נגישות' : 'Accessibility'}
        </a>
        <span>|</span>
        <a href="/ai-policy" className="hover:underline">
          {language === 'he' ? 'מדיניות AI' : 'AI Policy'}
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

  const { isAuthenticated, isLoading: authLoading, login, logoutQuietly, refetchUser, user } = useAuth();
  const { t, language, direction } = useLanguage();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  /** Get the right post-login destination. System admins go to /admin unless in support mode. */
  const getPostLoginPath = (u?: typeof user) => {
    const target = u ?? user;
    return (target?.isSystemAdmin && !target?.supportSession) ? '/admin' : '/home';
  };

  // View state
  const [showRegister, setShowRegister] = useState(isInviteMode);

  // Dev impersonation state
  const [impersonateEmail, setImpersonateEmail] = useState('');
  const [isImpersonating, setIsImpersonating] = useState(false);
  
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
  const [inviteUserType, setInviteUserType] = useState<UserType>('Caregiver');

  // Email mismatch auto-logout state
  const [isLoggingOutMismatch, setIsLoggingOutMismatch] = useState(false);

  // MFA state
  const [mfaStep, setMfaStep] = useState<'login' | 'mfa_verify' | 'mfa_setup'>('login');
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaQrCode, setMfaQrCode] = useState<string | null>(null);
  const [mfaManualKey, setMfaManualKey] = useState<string | null>(null);
  const [isVerifyingMfa, setIsVerifyingMfa] = useState(false);
  const [isSettingUpMfa, setIsSettingUpMfa] = useState(false);

  // Check for MFA redirect from OAuth
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const mfaRequired = urlParams.get('mfa_required');
    const mfaSetupRequired = urlParams.get('mfa_setup_required');
    const token = urlParams.get('mfa_token');

    if (mfaRequired === 'true' && token) {
      setMfaStep('mfa_verify');
      setMfaToken(decodeURIComponent(token));
      // Clean up URL
      window.history.replaceState({}, '', window.location.pathname);
    } else if (mfaSetupRequired === 'true' && token) {
      setMfaStep('mfa_setup');
      setMfaToken(decodeURIComponent(token));
      // Fetch MFA setup data
      fetchMfaSetup(decodeURIComponent(token));
      // Clean up URL
      window.history.replaceState({}, '', window.location.pathname);
    }

    // Surface SSO callback errors on the login page so the user understands
    // why their login attempt didn't succeed.
    const ssoError = urlParams.get('ssoError');
    if (ssoError) {
      const messages: Record<string, string> = {
        no_account: t('auth.ssoNoAccount') || "No account is linked to that identity. Please log in with your password and link the SSO provider from your account settings.",
        user_not_found: t('auth.ssoUserNotFound') || "The linked account no longer exists. Contact your administrator.",
        login_failed: t('auth.ssoLoginFailed') || "SSO sign-in could not establish a session. Please try again.",
        invalid_state: t('auth.ssoInvalidState') || "SSO session expired. Please retry.",
        invalid_relay_state: t('auth.ssoInvalidState') || "SSO session expired. Please retry.",
      };
      toast({
        title: t('auth.ssoError') || "Sign-in via SSO failed",
        description: messages[ssoError] || ssoError,
        variant: "destructive",
      });
      window.history.replaceState({}, '', window.location.pathname);
    }
  }, []);

  const fetchMfaSetup = async (token: string) => {
    setIsSettingUpMfa(true);
    try {
      const response = await apiRequest('POST', '/auth/mfa/setup-with-token', { mfaToken: token });
      const data = await response.json();
      if (data.success) {
        setMfaQrCode(data.qrCode);
        setMfaManualKey(data.manualEntryKey);
      } else {
        toast({
          title: 'MFA Setup Failed',
          description: data.message || 'Failed to start MFA setup',
          variant: 'destructive',
        });
        setMfaStep('login');
      }
    } catch {
      toast({
        title: 'MFA Setup Failed',
        description: 'Failed to start MFA setup',
        variant: 'destructive',
      });
      setMfaStep('login');
    } finally {
      setIsSettingUpMfa(false);
    }
  };

  // Fetch active identity providers for "Sign in with X" SSO buttons.
  // Pre-auth call; backend strips secrets and returns a public-safe shape.
  // Buttons only render for SAML / OIDC institutional providers, not generic
  // OAuth like Google (Google has its own dedicated button).
  const { data: ssoProvidersData } = useQuery<{
    providers: Array<{ id: string; name: string; protocol: 'oidc' | 'oauth2' | 'saml'; instituteIdType: string | null }>;
  }>({
    queryKey: ['/api/auth/identity-providers'],
    queryFn: async () => {
      const res = await apiRequest('GET', '/api/auth/identity-providers');
      return res.json();
    },
    staleTime: 60_000,
  });
  // Show only providers tied to an institute regime (e.g. il_moe, uk_dfe).
  // Generic providers without an instituteIdType — like global Google OAuth —
  // are rendered separately or via existing flows.
  const ssoProviders = (ssoProvidersData?.providers ?? [])
    .filter((p) => p.instituteIdType !== null);

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
        institute: InstituteData | null;
        invitedBy: InviterData | null;
        licenseInvite?: boolean;
        inviteDefaults?: { firstName?: string; lastName?: string; userType?: string } | null;
        existingUser?: { firstName?: string; lastName?: string } | null;
        mandatedSsoProvider?: { id: string; name: string; protocol: 'oidc' | 'oauth2' | 'saml' } | null;
      };
    },
    enabled: isInviteMode,
    retry: false,
  });

  // After Google OAuth redirect, auto-accept the pending invite
  useEffect(() => {
    if (!isAuthenticated || !user) return;
    const pendingToken = sessionStorage.getItem('pendingInviteToken');
    if (!pendingToken) return;
    sessionStorage.removeItem('pendingInviteToken');
    (async () => {
      try {
        // Fetch invite details to get the institute ID
        const inviteRes = await apiRequest('GET', `/api/invites/token/${pendingToken}`);
        const inviteInfo = await inviteRes.json();

        await apiRequest('POST', `/api/invites/token/${pendingToken}/accept`);
        toast({ title: t('invite.accepted') || 'Invite Accepted' });

        // Pre-select the new institute
        if (inviteInfo?.institute?.id && user?.id) {
          localStorage.setItem(`cliniaacian.${user.id}.currentInstituteId`, inviteInfo.institute.id);
        }
      } catch {
        // Accept failed — not critical
      }
      window.location.href = '/home';
    })();
  }, [isAuthenticated, user]);

  // Auto-logout if logged-in user doesn't match invite email
  useEffect(() => {
    if (!isInviteMode || !inviteData || !isAuthenticated || !user) return;
    if (user.email.toLowerCase() !== inviteData.invite.email.toLowerCase()) {
      setIsLoggingOutMismatch(true);
      logoutQuietly().finally(() => setIsLoggingOutMismatch(false));
    }
  }, [isInviteMode, isAuthenticated, inviteData, user]);

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
      const result = await login(loginData.email, loginData.password);

      // MFA required - show verification screen
      if (result.mfaRequired && result.mfaToken) {
        setMfaToken(result.mfaToken);
        setMfaStep('mfa_verify');
        setIsLoggingIn(false);
        return;
      }

      // MFA setup required - show setup screen
      if (result.mfaSetupRequired && result.mfaToken) {
        setMfaToken(result.mfaToken);
        setMfaStep('mfa_setup');
        fetchMfaSetup(result.mfaToken);
        setIsLoggingIn(false);
        return;
      }

      // Normal login success
      if (result.success && result.user) {
        await refetchUser();
        if (isInviteMode) {
          // Stay on the page — user needs to select userType before accepting
          toast({ title: t('auth.loginSuccess'), description: t('auth.welcomeBack') });
        } else {
          toast({ title: t('auth.loginSuccess'), description: t('auth.welcomeBack') });
          setLocation(getPostLoginPath(result.user));
        }
      } else {
        toast({
          title: t('auth.loginFailed'),
          description: result.message || t('auth.invalidCredentials'),
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

  const handleImpersonate = async (e: FormEvent) => {
    e.preventDefault();
    if (!impersonateEmail.trim()) return;
    setIsImpersonating(true);
    try {
      const response = await apiRequest('POST', '/auth/impersonate', { email: impersonateEmail });
      const data = await response.json();
      if (data.success && data.user) {
        await refetchUser();
        toast({ title: 'Impersonation', description: `Logged in as ${data.user.email}` });
        setLocation(getPostLoginPath(data.user));
      } else {
        toast({ title: 'Impersonation failed', description: data.message, variant: 'destructive' });
      }
    } catch (err: any) {
      toast({ title: 'Impersonation failed', description: err.message, variant: 'destructive' });
    } finally {
      setIsImpersonating(false);
    }
  };

  const handleMfaVerify = async () => {
    if (!mfaToken || mfaCode.length !== 6) return;

    setIsVerifyingMfa(true);
    try {
      const response = await apiRequest('POST', '/auth/mfa/verify', {
        mfaToken,
        code: mfaCode,
        rememberMe: false,
      });
      const data = await response.json();

      if (data.success && data.user) {
        await refetchUser();
        toast({
          title: t('auth.loginSuccess'),
          description: t('auth.welcomeBack'),
        });
        if (isInviteMode) {
          // Page will re-render and show accept invite UI
        } else {
          setLocation(getPostLoginPath());
        }
      } else {
        toast({
          title: 'Verification Failed',
          description: data.message || 'Invalid verification code',
          variant: 'destructive',
        });
      }
    } catch {
      toast({
        title: 'Verification Failed',
        description: 'Failed to verify code',
        variant: 'destructive',
      });
    } finally {
      setIsVerifyingMfa(false);
    }
  };

  const handleMfaSetupVerify = async () => {
    if (!mfaToken || mfaCode.length !== 6) return;

    setIsVerifyingMfa(true);
    try {
      const response = await apiRequest('POST', '/auth/mfa/verify-setup-with-token', {
        mfaToken,
        code: mfaCode,
        rememberMe: false,
      });
      const data = await response.json();

      if (data.success && data.user) {
        await refetchUser();
        toast({
          title: 'MFA Enabled',
          description: 'Two-factor authentication has been set up successfully.',
        });
        if (isInviteMode) {
          // Page will re-render and show accept invite UI
        } else {
          setLocation(getPostLoginPath());
        }
      } else {
        toast({
          title: 'Setup Failed',
          description: data.message || 'Invalid verification code',
          variant: 'destructive',
        });
      }
    } catch {
      toast({
        title: 'Setup Failed',
        description: 'Failed to complete MFA setup',
        variant: 'destructive',
      });
    } finally {
      setIsVerifyingMfa(false);
    }
  };

  const handleMfaRecoveryRequest = async () => {
    // Navigate to MFA recovery page
    setLocation('/mfa-recovery');
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
    const invDefaults = inviteData?.inviteDefaults;
    const d = {
      ...registerData,
      firstName: registerData.firstName || invDefaults?.firstName || '',
      lastName: registerData.lastName || invDefaults?.lastName || '',
      userType: registerData.userType || (invDefaults?.userType as UserType) || 'Caregiver',
    };

    const isExistingUser = isInviteMode && !!inviteData?.existingUser;

    // Validation — existing users only need password
    if (!d.password.trim()) {
      toast({ title: t('auth.error'), description: t('auth.fieldsRequired'), variant: 'destructive' });
      return;
    }

    if (!isExistingUser) {
      if (!d.firstName.trim()) {
        toast({ title: t('auth.error'), description: t('auth.fieldsRequired'), variant: 'destructive' });
        return;
      }

      if (!isInviteMode && !d.email.trim()) {
        toast({ title: t('auth.error'), description: t('auth.fieldsRequired'), variant: 'destructive' });
        return;
      }

      if (d.password !== d.confirmPassword) {
        toast({ title: t('auth.error'), description: t('auth.passwordMismatch'), variant: 'destructive' });
        return;
      }

      // Validate password against policy
      const passwordErrors: string[] = [];
      if (d.password.length < passwordPolicy.minLength) {
        passwordErrors.push(`Password must be at least ${passwordPolicy.minLength} characters`);
      }
      if (passwordPolicy.requireUppercase && !/[A-Z]/.test(d.password)) {
        passwordErrors.push('Password must contain at least one uppercase letter');
      }
      if (passwordPolicy.requireLowercase && !/[a-z]/.test(d.password)) {
        passwordErrors.push('Password must contain at least one lowercase letter');
      }
      if (passwordPolicy.requireNumber && !/[0-9]/.test(d.password)) {
        passwordErrors.push('Password must contain at least one number');
      }

      if (passwordErrors.length > 0) {
        toast({ title: t('auth.error'), description: passwordErrors[0], variant: 'destructive' });
        return;
      }
    }

    setIsRegistering(true);

    try {
      let response;

      if (isExistingUser && inviteData) {
        // Existing user: log in and accept invite
        const loginResult = await login(inviteData.invite.email, d.password);
        if (!loginResult.success) {
          throw new Error(loginResult.message || t('auth.invalidCredentials') || 'Invalid password');
        }
        // Now accept the invite with userType
        response = await apiRequest('POST', `/api/invites/token/${inviteToken}/accept`, { userType: d.userType });
      } else if (isInviteMode) {
        // New user: register via invite
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
          description: inviteData.institute
            ? (t('invite.registeredDesc') || 'Your account has been created and you have joined {institute}').replace('{institute}', inviteData.institute.name)
            : (t('invite.licenseActivated') || 'Your account has been created and your license is active.')
        });
        // Pre-select the new institute and reload to refresh all contexts
        if (inviteData.institute?.id && data.user?.id) {
          localStorage.setItem(`cliniaacian.${data.user.id}.currentInstituteId`, inviteData.institute.id);
        }
        window.location.href = '/home';
      } else {
        toast({
          title: t('auth.registerSuccess'),
          description: t('auth.registerSuccessDesc')
        });
        setLocation(getPostLoginPath());
      }
      
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
      const response = await apiRequest('POST', `/api/invites/token/${inviteToken}/accept`, { userType: inviteUserType });
      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Failed to accept invite');
      }

      toast({
        title: t('invite.accepted') || 'Invite Accepted',
        description: inviteData?.institute
          ? (t('invite.acceptedDesc') || 'You have joined {institute}').replace('{institute}', inviteData.institute.name)
          : (t('invite.licenseActivated') || 'Your license has been activated.'),
      });

      // Pre-select the new institute and full-reload to refresh all contexts
      if (inviteData?.institute?.id && user?.id) {
        localStorage.setItem(`cliniaacian.${user.id}.currentInstituteId`, inviteData.institute.id);
      }
      window.location.href = '/home';
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
  if (authLoading || (isInviteMode && inviteLoading) || isLoggingOutMismatch) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="w-8 h-8 animate-spin text-primary" />
          {isLoggingOutMismatch && (
            <p className="text-sm text-muted-foreground">{t('invite.switchingAccounts')}</p>
          )}
        </div>
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
            {institute ? (
              <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                {institute.type === 'clinic' ? (
                  <Hospital className="w-8 h-8 text-primary" />
                ) : (
                  <School className="w-8 h-8 text-primary" />
                )}
              </div>
            ) : (
              <img src={aivotaLogo} alt="Aivota" className="mx-auto h-16 mb-4 object-contain" />
            )}
            <CardTitle className="text-2xl font-bold">
              {institute
                ? (t('invite.joinTitle') || 'Welcome to {institute}').replace('{institute}', institute.name)
                : (t('invite.activateLicense') || 'Activate Your License')}
            </CardTitle>
            <CardDescription>
              {institute
                ? (invitedBy?.fullName
                    ? (t('invite.invitedBy') || 'You have been invited by {name}').replace('{name}', invitedBy.fullName)
                    : (t('invite.invitedToJoin') || 'You have been invited to join'))
                : (t('invite.licenseInviteDesc') || 'Click below to activate your license')}
            </CardDescription>
          </CardHeader>

          <CardContent className="space-y-4">
            {/* Institute Info */}
            {institute && (
              <div className="bg-muted rounded-lg p-4 text-center">
                <h3 className="text-lg font-semibold">{institute.name}</h3>
                <p className="text-sm text-muted-foreground">
                  {t(`institute.type.${institute.type}`) || institute.type}
                </p>
              </div>
            )}

            {/* Role Info */}
            {institute && (
              <div className="flex items-center justify-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {t('invite.yourRole') || 'Your role:'}
                </span>
                <Badge variant="secondary">{invite.role}</Badge>
                {invite.grantAdmin && (
                  <Badge variant="outline">{t('invite.admin') || 'Admin'}</Badge>
                )}
              </div>
            )}

            {/* Message */}
            {invite.message && (
              <div className="bg-muted/50 rounded-lg p-3">
                <p className="text-sm italic">"{invite.message}"</p>
              </div>
            )}

            {/* User Type */}
            <div className="space-y-2">
              <Label>{language === 'he' ? 'סוג משתמש' : 'Your Role'}</Label>
              <Select
                value={inviteUserType}
                onValueChange={(v) => setInviteUserType(v as UserType)}
              >
                <SelectTrigger>
                  <SelectValue />
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
        {/* MFA Verification Step */}
        {mfaStep === 'mfa_verify' && (
          <>
            <CardHeader className="space-y-1 text-center">
              <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                <Shield className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="text-2xl font-bold">
                Two-Factor Authentication
              </CardTitle>
              <CardDescription>
                Enter the 6-digit code from your authenticator app
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              <div className="flex justify-center">
                <InputOTP
                  maxLength={6}
                  value={mfaCode}
                  onChange={(value) => setMfaCode(value)}
                >
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

              <Button
                className="w-full"
                onClick={handleMfaVerify}
                disabled={mfaCode.length !== 6 || isVerifyingMfa}
              >
                {isVerifyingMfa ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin me-2" />
                    Verifying...
                  </>
                ) : (
                  'Verify'
                )}
              </Button>
            </CardContent>

            <CardFooter className="flex flex-col gap-3">
              <button
                type="button"
                onClick={() => {
                  setMfaStep('login');
                  setMfaToken(null);
                  setMfaCode('');
                }}
                className="text-sm text-muted-foreground hover:text-primary hover:underline"
              >
                Back to login
              </button>
              <button
                type="button"
                onClick={handleMfaRecoveryRequest}
                className="text-sm text-muted-foreground hover:text-primary hover:underline"
              >
                Lost access to authenticator?
              </button>
            </CardFooter>
          </>
        )}

        {/* MFA Setup Step */}
        {mfaStep === 'mfa_setup' && (
          <>
            <CardHeader className="space-y-1 text-center">
              <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                <KeyRound className="w-6 h-6 text-primary" />
              </div>
              <CardTitle className="text-2xl font-bold">
                Set Up Two-Factor Authentication
              </CardTitle>
              <CardDescription>
                Your administrator requires MFA for this account
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-6">
              {isSettingUpMfa ? (
                <div className="flex justify-center py-8">
                  <Loader2 className="w-8 h-8 animate-spin text-primary" />
                </div>
              ) : mfaQrCode ? (
                <>
                  <p className="text-sm text-center text-muted-foreground">
                    Scan this QR code with your authenticator app
                  </p>
                  <div className="flex justify-center">
                    <img
                      src={mfaQrCode}
                      alt="MFA QR Code"
                      className="w-48 h-48 border rounded"
                    />
                  </div>
                  {mfaManualKey && (
                    <div className="text-center">
                      <p className="text-xs text-muted-foreground mb-1">Or enter this key manually:</p>
                      <code className="bg-muted px-2 py-1 rounded text-sm font-mono select-all">
                        {mfaManualKey}
                      </code>
                    </div>
                  )}
                  <div className="space-y-2">
                    <Label htmlFor="login-mfa-code" className="text-center block">Enter the 6-digit code:</Label>
                    <div className="flex justify-center">
                      <InputOTP
                        id="login-mfa-code"
                        maxLength={6}
                        value={mfaCode}
                        onChange={(value) => setMfaCode(value)}
                      >
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
                  <Button
                    className="w-full"
                    onClick={handleMfaSetupVerify}
                    disabled={mfaCode.length !== 6 || isVerifyingMfa}
                  >
                    {isVerifyingMfa ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin me-2" />
                        Setting up...
                      </>
                    ) : (
                      'Complete Setup'
                    )}
                  </Button>
                </>
              ) : (
                <p className="text-center text-muted-foreground">
                  Failed to load MFA setup. Please try again.
                </p>
              )}
            </CardContent>

            <CardFooter className="flex justify-center">
              <button
                type="button"
                onClick={() => {
                  setMfaStep('login');
                  setMfaToken(null);
                  setMfaCode('');
                  setMfaQrCode(null);
                  setMfaManualKey(null);
                }}
                className="text-sm text-muted-foreground hover:text-primary hover:underline"
              >
                Back to login
              </button>
            </CardFooter>
          </>
        )}

        {/* Normal Login Form */}
        {mfaStep === 'login' && !showRegister && (
          // Login Form
          <>
            <CardHeader className="space-y-1 text-center">
              <img src={aivotaLogo} alt="Aivota" className="mx-auto h-16 mb-4 object-contain" />
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

                {/* Google Login Button - hidden for now */}
                {false && <Button
                  variant="outline"
                  className="w-full"
                  onClick={handleGoogleLogin}
                  type="button"
                  data-testid="button-google-login"
                >
                  <GoogleIcon className="w-4 h-4 me-2" />
                  {t('auth.googleLogin')}
                </Button>}

                {/* Institutional SSO buttons — one per active provider with an
                    instituteIdType set (e.g. il_moe, uk_dfe). Clicking starts
                    the SSO flow; the callback will log the user in via their
                    linked external identity, or return ssoError=no_account if
                    they haven't linked yet. */}
                {ssoProviders.length > 0 && (
                  <div className="flex flex-col gap-2">
                    {ssoProviders.map((p) => (
                      <Button
                        key={p.id}
                        variant="outline"
                        className="w-full"
                        type="button"
                        onClick={() => {
                          window.location.href = `/api/identity/link/${p.id}?returnUrl=/`;
                        }}
                        data-testid={`button-sso-${p.id}`}
                      >
                        <Shield className="w-4 h-4 me-2" />
                        {t('auth.ssoLogin', { provider: p.name }) || `Sign in with ${p.name}`}
                      </Button>
                    ))}
                  </div>
                )}
              </CardContent>

              <CardFooter className="flex flex-col gap-3">
                {/* Signup link - hidden for now */}
                {false && <button
                  type="button"
                  onClick={() => setShowRegister(true)}
                  className="text-sm text-primary hover:underline"
                >
                  {t('auth.noAccount')}
                </button>}

                <button
                  type="button"
                  className="text-sm text-muted-foreground hover:text-primary hover:underline"
                  onClick={() => setLocation('/forgot-password')}
                >
                  {t('auth.forgotPassword')}
                </button>

                <button
                  type="button"
                  className="text-sm text-muted-foreground hover:text-primary hover:underline"
                  onClick={() => setLocation('/')}
                >
                  {t('auth.backToHome')}
                </button>
              </CardFooter>
            </form>

            {/* Dev-only impersonation */}
            {import.meta.env.DEV && (
              <form onSubmit={handleImpersonate} className="px-6 pb-6">
                <div className="border-t pt-4 space-y-2">
                  <p className="text-xs font-medium text-orange-600">Dev: Login as user</p>
                  <div className="flex gap-2">
                    <Input
                      type="email"
                      placeholder="user@example.com"
                      value={impersonateEmail}
                      onChange={(e) => setImpersonateEmail(e.target.value)}
                      required
                      dir="ltr"
                      className="text-sm"
                    />
                    <Button
                      type="submit"
                      variant="outline"
                      size="sm"
                      disabled={isImpersonating}
                      className="shrink-0 border-orange-300 text-orange-600 hover:bg-orange-50"
                      aria-label={isImpersonating ? "Impersonating, please wait" : "Impersonate user"}
                    >
                      {isImpersonating ? <Loader2 className="w-4 h-4 animate-spin" /> : <LogIn className="w-4 h-4" />}
                    </Button>
                  </div>
                </div>
              </form>
            )}
          </>
        )}

        {/* Registration Form */}
        {mfaStep === 'login' && showRegister && (
          <>
            <CardHeader className="space-y-1 text-center">
              {isInviteMode && inviteData ? (
                // Invite mode header
                <>
                  {inviteData.institute ? (
                    <div className="mx-auto w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                      {inviteData.institute.type === 'clinic' ? (
                        <Hospital className="w-8 h-8 text-primary" />
                      ) : (
                        <School className="w-8 h-8 text-primary" />
                      )}
                    </div>
                  ) : (
                    <img src={aivotaLogo} alt="Aivota" className="mx-auto h-16 mb-4 object-contain" />
                  )}
                  <CardTitle className="text-2xl font-bold">
                    {inviteData.existingUser
                      ? (t('invite.joinInstitute') || 'Join Institute')
                      : (t('invite.createAccount') || 'Create Your Account')}
                  </CardTitle>
                  <CardDescription>
                    {inviteData.institute
                      ? (inviteData.invitedBy?.fullName
                          ? (t('invite.invitedByToJoin') || '{name} invited you to join {institute}')
                              .replace('{name}', inviteData.invitedBy.fullName)
                              .replace('{institute}', inviteData.institute.name)
                          : (t('invite.invitedToJoinInstitute') || 'You have been invited to join {institute}')
                              .replace('{institute}', inviteData.institute.name))
                      : (t('invite.licenseInviteDesc') || 'You have been invited to join CliniAACian')
                    }
                  </CardDescription>
                </>
              ) : (
                // Regular registration header
                <>
                  <img src={aivotaLogo} alt="Aivota" className="mx-auto h-16 mb-4 object-contain" />
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
                {isInviteMode && inviteData && inviteData.institute && (
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

                {/* Regime-mandated SSO promotion. When the inviting institute's
                    license declares a compliance regime that hints at a specific
                    identity provider (e.g. il_moe → Sapakim), surface that
                    provider as the recommended sign-in path. The email/password
                    form below stays available as a fallback. */}
                {isInviteMode && inviteData?.mandatedSsoProvider && inviteData.institute && (
                  <div className="rounded-lg border border-primary/30 bg-primary/5 p-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <Shield className="w-4 h-4 text-primary" />
                      <p className="font-medium text-sm">
                        {t('auth.ssoMandatedTitle') || 'Required sign-in'}
                      </p>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {(t('auth.ssoMandatedDesc') || '{institute} requires sign-in via {provider}. Click below to continue.')
                        .replace('{institute}', inviteData.institute.name)
                        .replace('{provider}', inviteData.mandatedSsoProvider.name)}
                    </p>
                    <Button
                      type="button"
                      className="w-full"
                      onClick={() => {
                        const provider = inviteData.mandatedSsoProvider!;
                        // Persist token so post-OAuth callback auto-accepts the invite (see useEffect above).
                        if (inviteToken) sessionStorage.setItem('pendingInviteToken', inviteToken);
                        const returnUrl = encodeURIComponent(window.location.pathname + window.location.search);
                        window.location.href = `/api/identity/link/${provider.id}?returnUrl=${returnUrl}`;
                      }}
                      data-testid="button-mandated-sso"
                    >
                      <Shield className="w-4 h-4 me-2" />
                      {(t('auth.ssoLogin') || 'Sign in with {provider}').replace('{provider}', inviteData.mandatedSsoProvider.name)}
                    </Button>
                    <div className="relative pt-1">
                      <div className="absolute inset-0 flex items-center pt-1">
                        <span className="w-full border-t" />
                      </div>
                      <div className="relative flex justify-center text-xs">
                        <span className="bg-card px-2 text-muted-foreground">
                          {t('auth.orUseEmailPassword') || 'Or sign in with email & password'}
                        </span>
                      </div>
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

                {/* Name fields — hidden for existing users (name already in system) */}
                {!(isInviteMode && inviteData?.existingUser) && (
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="firstName">
                        {t('auth.firstName') || 'First Name'} {isInviteMode && '*'}
                      </Label>
                      <Input
                        id="firstName"
                        type="text"
                        value={registerData.firstName || inviteData?.inviteDefaults?.firstName || ''}
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
                        value={registerData.lastName || inviteData?.inviteDefaults?.lastName || ''}
                        onChange={(e) => setRegisterData(prev => ({ ...prev, lastName: e.target.value }))}
                        placeholder={t('auth.lastNamePlaceholder')}
                        required={!isInviteMode}
                        disabled={isRegistering}
                      />
                    </div>
                  </div>
                )}

                {/* Greeting for existing users */}
                {isInviteMode && inviteData?.existingUser && (
                  <p className="text-sm text-muted-foreground">
                    {(t('invite.welcomeBack') || 'Welcome back, {name}! Enter your password to join.').replace(
                      '{name}', inviteData.existingUser.firstName || inviteData.invite.email
                    )}
                  </p>
                )}

                {/* User Type */}
                <div className="space-y-2">
                  <Label htmlFor="userType">
                    {language === 'he' ? 'סוג משתמש' : 'User Type'}
                  </Label>
                  <Select
                    value={registerData.userType || (inviteData?.inviteDefaults?.userType as UserType) || 'Caregiver'}
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

                {/* Confirm Password — not needed for existing users */}
                {!(isInviteMode && inviteData?.existingUser) && (
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
                )}

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
                  ) : isInviteMode && inviteData?.existingUser ? (
                    <>
                      <CheckCircle className="w-4 h-4 me-2" />
                      {t('invite.loginAndJoin') || 'Log In & Join'}
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
                {isInviteMode && inviteData?.existingUser ? (
                  null
                ) : isInviteMode ? (
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