// src/pages/AdminLoginPage.tsx
// Dedicated admin login at /admin. Admins navigate here directly — there's no
// link to it from the regular login UI. Auth posts to the unified /auth/login
// endpoint (LocalStrategy checks admin_users first); password/MFA recovery
// links point at the admin-specific /auth/admin/* paths.

import { useState, FormEvent, useEffect } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { InputOTP, InputOTPGroup, InputOTPSlot } from '@/components/ui/input-otp';
import { useAuth } from '@/hooks/useAuth';
import { useLanguage } from '@/contexts/LanguageContext';
import { LanguageSelector } from '@/components/LanguageSelector';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import { Loader2, LogIn, Shield, KeyRound } from 'lucide-react';
import aivotaLogo from '@assets/aivota_logo.png';

type Step = 'login' | 'mfa_verify' | 'mfa_setup';

export default function AdminLoginPage() {
  const { login, refetchUser } = useAuth();
  const { t, direction } = useLanguage();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [step, setStep] = useState<Step>('login');
  const [loginData, setLoginData] = useState({ email: '', password: '' });
  const [isLoggingIn, setIsLoggingIn] = useState(false);

  // MFA state
  const [mfaToken, setMfaToken] = useState<string | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [mfaQrCode, setMfaQrCode] = useState<string | null>(null);
  const [mfaManualKey, setMfaManualKey] = useState<string | null>(null);
  const [isVerifyingMfa, setIsVerifyingMfa] = useState(false);
  const [isSettingUpMfa, setIsSettingUpMfa] = useState(false);

  // Pick up MFA continuation from OAuth redirects, same convention as LoginPage.
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const mfaRequired = urlParams.get('mfa_required');
    const mfaSetupRequired = urlParams.get('mfa_setup_required');
    const token = urlParams.get('mfa_token');

    if (mfaRequired === 'true' && token) {
      setStep('mfa_verify');
      setMfaToken(decodeURIComponent(token));
      window.history.replaceState({}, '', window.location.pathname);
    } else if (mfaSetupRequired === 'true' && token) {
      setStep('mfa_setup');
      setMfaToken(decodeURIComponent(token));
      fetchMfaSetup(decodeURIComponent(token));
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
          title: t('settings.mfaSetupFailed'),
          description: data.message || t('settings.mfaSetupFailedDesc'),
          variant: 'destructive',
        });
        setStep('login');
      }
    } catch {
      toast({
        title: t('settings.mfaSetupFailed'),
        description: t('settings.mfaSetupFailedDesc'),
        variant: 'destructive',
      });
      setStep('login');
    } finally {
      setIsSettingUpMfa(false);
    }
  };

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();

    if (!loginData.email.trim() || !loginData.password.trim()) {
      toast({
        title: t('auth.error') || 'Error',
        description: t('auth.fieldsRequired') || 'Email and password are required',
        variant: 'destructive',
      });
      return;
    }

    setIsLoggingIn(true);
    try {
      const result = await login(loginData.email, loginData.password);

      if (result.mfaRequired && result.mfaToken) {
        setMfaToken(result.mfaToken);
        setStep('mfa_verify');
        return;
      }

      if (result.mfaSetupRequired && result.mfaToken) {
        setMfaToken(result.mfaToken);
        setStep('mfa_setup');
        fetchMfaSetup(result.mfaToken);
        return;
      }

      if (result.success && result.user) {
        await refetchUser();
        if (!result.user.isSystemAdmin) {
          // Non-admin used the /admin entry point — bounce them to /home.
          toast({
            title: t('auth.loginSuccess') || 'Logged in',
            description: t('auth.notAnAdmin'),
          });
          setLocation('/home');
          return;
        }
        toast({
          title: t('auth.loginSuccess') || 'Logged in',
          description: t('auth.welcomeBack') || 'Welcome back',
        });
        setLocation('/admin');
        return;
      }

      toast({
        title: t('auth.loginFailed') || 'Login failed',
        description: result.message || t('auth.invalidCredentials') || 'Invalid login credentials',
        variant: 'destructive',
      });
    } catch {
      toast({
        title: t('auth.loginFailed') || 'Login failed',
        description: t('auth.loginError') || 'Login error',
        variant: 'destructive',
      });
    } finally {
      setIsLoggingIn(false);
    }
  };

  const handleMfaVerify = async (code: string = mfaCode) => {
    if (!mfaToken || code.length !== 6 || isVerifyingMfa) return;
    setIsVerifyingMfa(true);
    try {
      const response = await apiRequest('POST', '/auth/mfa/verify', {
        mfaToken,
        code,
        rememberMe: false,
      });
      const data = await response.json();

      if (data.success && data.user) {
        await refetchUser();
        toast({
          title: t('auth.loginSuccess') || 'Logged in',
          description: t('auth.welcomeBack') || 'Welcome back',
        });
        setLocation(data.user.isSystemAdmin ? '/admin' : '/home');
        return;
      }

      toast({
        title: t('settings.mfaVerificationFailed'),
        description: data.message || t('settings.mfaInvalidCode'),
        variant: 'destructive',
      });
    } catch {
      toast({
        title: t('settings.mfaVerificationFailed'),
        description: t('settings.mfaVerificationFailedDesc'),
        variant: 'destructive',
      });
    } finally {
      setIsVerifyingMfa(false);
    }
  };

  const handleMfaSetupVerify = async (code: string = mfaCode) => {
    if (!mfaToken || code.length !== 6 || isVerifyingMfa) return;
    setIsVerifyingMfa(true);
    try {
      const response = await apiRequest('POST', '/auth/mfa/verify-setup-with-token', {
        mfaToken,
        code,
        rememberMe: false,
      });
      const data = await response.json();

      if (data.success && data.user) {
        await refetchUser();
        toast({
          title: t('settings.mfaSetupSuccess'),
          description: t('settings.mfaEnabledDesc'),
        });
        setLocation(data.user.isSystemAdmin ? '/admin' : '/home');
        return;
      }

      toast({
        title: t('settings.mfaSetupFailed'),
        description: data.message || t('settings.mfaInvalidCode'),
        variant: 'destructive',
      });
    } catch {
      toast({
        title: t('settings.mfaSetupFailed'),
        description: t('settings.mfaVerificationFailedDesc'),
        variant: 'destructive',
      });
    } finally {
      setIsVerifyingMfa(false);
    }
  };

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
          {step === 'login' && (
            <>
              <CardHeader className="space-y-1 text-center">
                <img src={aivotaLogo} alt="Aivota" className="mx-auto h-16 mb-4 object-contain" />
                <CardTitle className="text-2xl font-bold flex items-center justify-center gap-2">
                  <Shield className="w-6 h-6 text-primary" />
                  {t('admin.loginTitle')}
                </CardTitle>
                <CardDescription>
                  {t('admin.loginSubtitle')}
                </CardDescription>
              </CardHeader>

              <form onSubmit={handleLogin}>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">{t('auth.email') || 'Email'}</Label>
                    <Input
                      id="email"
                      type="email"
                      value={loginData.email}
                      onChange={(e) => setLoginData((prev) => ({ ...prev, email: e.target.value }))}
                      placeholder={t('auth.emailPlaceholder') || 'admin@example.com'}
                      required
                      dir="ltr"
                      disabled={isLoggingIn}
                      data-testid="input-admin-email"
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="password">{t('auth.password') || 'Password'}</Label>
                    <Input
                      id="password"
                      type="password"
                      value={loginData.password}
                      onChange={(e) =>
                        setLoginData((prev) => ({ ...prev, password: e.target.value }))
                      }
                      placeholder={t('auth.passwordPlaceholder') || 'Password'}
                      required
                      dir="ltr"
                      disabled={isLoggingIn}
                      data-testid="input-admin-password"
                    />
                  </div>

                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isLoggingIn}
                    data-testid="button-admin-login"
                  >
                    {isLoggingIn ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin me-2" />
                        {t('auth.loggingIn') || 'Signing in…'}
                      </>
                    ) : (
                      <>
                        <LogIn className="w-4 h-4 me-2" />
                        {t('auth.loginButton') || 'Sign in'}
                      </>
                    )}
                  </Button>
                </CardContent>

                <CardFooter className="flex flex-col gap-3">
                  <button
                    type="button"
                    onClick={() => setLocation('/admin/forgot-password')}
                    className="text-sm text-muted-foreground hover:text-primary hover:underline"
                  >
                    {t('auth.forgotPassword') || 'Forgot password?'}
                  </button>
                  <button
                    type="button"
                    onClick={() => setLocation('/admin/mfa-recovery')}
                    className="text-sm text-muted-foreground hover:text-primary hover:underline"
                  >
                    {t('auth.mfaLostAccess')}
                  </button>
                </CardFooter>
              </form>
            </>
          )}

          {step === 'mfa_verify' && (
            <>
              <CardHeader className="space-y-1 text-center">
                <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                  <Shield className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-2xl font-bold">{t('auth.mfaTitle')}</CardTitle>
                <CardDescription>{t('auth.mfaPrompt')}</CardDescription>
              </CardHeader>

              <CardContent className="space-y-6">
                <div className="flex justify-center">
                  <InputOTP
                    maxLength={6}
                    value={mfaCode}
                    onChange={(value) => setMfaCode(value)}
                    onComplete={(value) => handleMfaVerify(value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleMfaVerify();
                    }}
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
                  onClick={() => handleMfaVerify()}
                  disabled={mfaCode.length !== 6 || isVerifyingMfa}
                >
                  {isVerifyingMfa ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin me-2" />
                      {t('settings.mfaVerifying')}
                    </>
                  ) : (
                    t('auth.mfaVerify')
                  )}
                </Button>
              </CardContent>

              <CardFooter className="flex flex-col gap-3">
                <button
                  type="button"
                  onClick={() => {
                    setStep('login');
                    setMfaToken(null);
                    setMfaCode('');
                  }}
                  className="text-sm text-muted-foreground hover:text-primary hover:underline"
                >
                  {t('auth.mfaBackToSignIn')}
                </button>
                <button
                  type="button"
                  onClick={() => setLocation('/admin/mfa-recovery')}
                  className="text-sm text-muted-foreground hover:text-primary hover:underline"
                >
                  {t('auth.mfaLostAccess')}
                </button>
              </CardFooter>
            </>
          )}

          {step === 'mfa_setup' && (
            <>
              <CardHeader className="space-y-1 text-center">
                <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                  <KeyRound className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-2xl font-bold">{t('auth.mfaSetupTitle')}</CardTitle>
                <CardDescription>{t('auth.mfaSetupAdminRequired')}</CardDescription>
              </CardHeader>

              <CardContent className="space-y-6">
                {isSettingUpMfa ? (
                  <div className="flex justify-center py-8">
                    <Loader2 className="w-8 h-8 animate-spin text-primary" />
                  </div>
                ) : mfaQrCode ? (
                  <>
                    <p className="text-sm text-center text-muted-foreground">
                      {t('settings.mfaScanQr')}
                    </p>
                    <div className="flex justify-center">
                      <img src={mfaQrCode} alt="MFA QR Code" className="w-48 h-48 border rounded" />
                    </div>
                    {mfaManualKey && (
                      <div className="text-center">
                        <p className="text-xs text-muted-foreground mb-1">
                          {t('settings.mfaManualKey')}
                        </p>
                        <code className="bg-muted px-2 py-1 rounded text-sm font-mono select-all">
                          {mfaManualKey}
                        </code>
                      </div>
                    )}
                    <div className="space-y-2">
                      <Label htmlFor="admin-mfa-code" className="text-center block">
                        {t('settings.mfaEnterCode')}
                      </Label>
                      <div className="flex justify-center">
                        <InputOTP
                          id="admin-mfa-code"
                          maxLength={6}
                          value={mfaCode}
                          onChange={(value) => setMfaCode(value)}
                          onComplete={(value) => handleMfaSetupVerify(value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') handleMfaSetupVerify();
                          }}
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
                      onClick={() => handleMfaSetupVerify()}
                      disabled={mfaCode.length !== 6 || isVerifyingMfa}
                    >
                      {isVerifyingMfa ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin me-2" />
                          {t('settings.mfaSettingUp')}
                        </>
                      ) : (
                        t('auth.mfaCompleteSetup')
                      )}
                    </Button>
                  </>
                ) : (
                  <p className="text-center text-muted-foreground">
                    {t('auth.mfaSetupLoadFailed')}
                  </p>
                )}
              </CardContent>

              <CardFooter className="flex justify-center">
                <button
                  type="button"
                  onClick={() => {
                    setStep('login');
                    setMfaToken(null);
                    setMfaCode('');
                    setMfaQrCode(null);
                    setMfaManualKey(null);
                  }}
                  className="text-sm text-muted-foreground hover:text-primary hover:underline"
                >
                  {t('auth.mfaBackToSignIn')}
                </button>
              </CardFooter>
            </>
          )}
        </Card>
      </main>

      <footer className="p-4 text-center text-sm text-muted-foreground space-x-2 rtl:space-x-reverse">
        <a href="/terms-of-service" className="hover:underline">
          {t('auth.termsOfService')}
        </a>
        <span>|</span>
        <a href="/privacy-policy" className="hover:underline">
          {t('auth.privacyPolicy')}
        </a>
      </footer>
    </div>
  );
}
