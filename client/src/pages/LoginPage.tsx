// src/pages/LoginPage.tsx
import { useState, FormEvent } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/hooks/useAuth';
import { useLanguage } from '@/contexts/LanguageContext';
import { LanguageSelector } from '@/components/LanguageSelector';
import { useToast } from '@/hooks/use-toast';
import { LogIn, Loader2, UserPlus } from 'lucide-react';
import { apiRequest } from '@/lib/queryClient';

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

export default function LoginPage() {
  const { login, isLoading: authLoading, refetchUser } = useAuth();
  const { t, language, direction } = useLanguage();
  const { toast } = useToast();
  const [, setLocation] = useLocation();
  
  // Login form state
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  
  // Registration form state
  const [showRegister, setShowRegister] = useState(false);
  const [registerData, setRegisterData] = useState({
    firstName: '',
    lastName: '',
    email: '',
    password: '',
    confirmPassword: '',
    userType: 'Caregiver' as 'admin' | 'Teacher' | 'Caregiver' | 'SLP' | 'Parent',
  });
  const [isRegistering, setIsRegistering] = useState(false);

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    
    if (!email.trim() || !password.trim()) {
      toast({ 
        title: t('auth.error'), 
        description: t('auth.fieldsRequired'), 
        variant: 'destructive' 
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const success = await login(email, password);
      if (success) {
        await refetchUser();
        toast({ 
          title: t('auth.loginSuccess'), 
          description: t('auth.welcomeBack') 
        });
        setLocation('/');
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
      setIsSubmitting(false);
    }
  };

  const handleGoogleLogin = () => {
    window.location.href = '/auth/google';
  };

  const handleRegister = async (e: FormEvent) => {
    e.preventDefault();
    const d = registerData;

    // Validation
    if (!d.firstName.trim() || !d.lastName.trim() || !d.email.trim() || !d.password.trim() || !d.confirmPassword.trim()) {
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

    setIsRegistering(true);

    try {
        const response = await apiRequest("POST", "/auth/register", {
            email: d.email,
            firstName: d.firstName,
            lastName: d.lastName,
            password: d.password,
            userType: d.userType,
        });

      const data = await response.json();

      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Registration failed');
      }

      // Registration successful
      await refetchUser();
      toast({ 
        title: t('auth.registerSuccess'), 
        description: t('auth.registerSuccessDesc') 
      });
      
      // Reset form and redirect
      setRegisterData({ 
        firstName: '', 
        lastName: '', 
        email: '', 
        password: '', 
        confirmPassword: '', 
        userType: 'Caregiver' 
      });
      setLocation('/');
      
    } catch {
      toast({ 
        title: t('auth.registerFailed'), 
        description: t('auth.registerError'), 
        variant: 'destructive' 
      });
    } finally {
      setIsRegistering(false);
    }
  };

  // User type options with translations
  const userTypeOptions = [
    { value: 'Caregiver', label: language === 'he' ? 'מטפל/ת' : 'Caregiver' },
    { value: 'Parent', label: language === 'he' ? 'הורה' : 'Parent' },
    { value: 'Teacher', label: language === 'he' ? 'מורה' : 'Teacher' },
    { value: 'SLP', label: language === 'he' ? 'קלינאי תקשורת' : 'SLP' },
  ];

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <Loader2 className="w-8 h-8 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <div 
      className="min-h-screen flex flex-col bg-gradient-to-br from-background to-muted"
      dir={direction}
    >
      {/* Header with language selector */}
      <header className="p-4 flex justify-end">
        <LanguageSelector />
      </header>

      {/* Main content */}
      <main className="flex-1 flex items-center justify-center p-4">
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
                  {t('auth.loginDescription')}
                </CardDescription>
              </CardHeader>

              <form onSubmit={handleLogin}>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">{t('auth.email')}</Label>
                    <Input
                      id="email"
                      type="email"
                      placeholder={t('auth.emailPlaceholder')}
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      required
                      autoComplete="email"
                      dir="ltr"
                      disabled={isSubmitting}
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="password">{t('auth.password')}</Label>
                    <Input
                      id="password"
                      type="password"
                      placeholder={t('auth.passwordPlaceholder')}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      required
                      autoComplete="current-password"
                      dir="ltr"
                      disabled={isSubmitting}
                    />
                  </div>

                  <Button 
                    type="submit" 
                    className="w-full" 
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin me-2" />
                        {t('auth.loggingIn')}
                      </>
                    ) : (
                      t('auth.loginWithEmail')
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
                    onClick={() => {
                      // TODO: Implement password recovery
                      toast({
                        title: t('auth.forgotPassword'),
                        description: language === 'he' 
                          ? 'תכונה זו תהיה זמינה בקרוב' 
                          : 'This feature will be available soon',
                      });
                    }}
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
              </CardHeader>

              <form onSubmit={handleRegister}>
                <CardContent className="space-y-4">
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <Label htmlFor="firstName">{t('auth.firstName')}</Label>
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
                        required
                        disabled={isRegistering}
                      />
                    </div>
                  </div>

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

                  <div className="space-y-2">
                    <Label htmlFor="userType">
                      {language === 'he' ? 'סוג משתמש' : 'User Type'}
                    </Label>
                    <Select
                      value={registerData.userType}
                      onValueChange={(value) => setRegisterData(prev => ({ 
                        ...prev, 
                        userType: value as typeof registerData.userType 
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

                  <div className="space-y-2">
                    <Label htmlFor="regPassword">{t('auth.password')}</Label>
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

                  <div className="space-y-2">
                    <Label htmlFor="confirmPassword">{t('auth.confirmPassword')}</Label>
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
                  >
                    {isRegistering ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin me-2" />
                        {t('auth.registering')}
                      </>
                    ) : (
                      t('auth.registerButton')
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
                    data-testid="button-google-register"
                  >
                    <GoogleIcon className="w-4 h-4 me-2" />
                    {t('auth.googleLogin')}
                  </Button>
                </CardContent>

                <CardFooter className="flex justify-center">
                  <button
                    type="button"
                    onClick={() => setShowRegister(false)}
                    className="text-sm text-primary hover:underline"
                  >
                    {t('auth.backToLogin')}
                  </button>
                </CardFooter>
              </form>
            </>
          )}
        </Card>
      </main>

      {/* Footer */}
      <footer className="p-4 text-center text-sm text-muted-foreground">
        <a href="/terms-of-service" className="hover:underline">
          {language === 'he' ? 'תנאי שימוש' : 'Terms of Service'}
        </a>
      </footer>
    </div>
  );
}