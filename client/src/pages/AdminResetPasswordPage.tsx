// src/pages/AdminResetPasswordPage.tsx
// Admin password reset confirmation. Reached from the link in the email
// (/admin/reset-password/:token). Validates via GET /auth/admin/reset-password/:token
// and submits via POST /auth/admin/reset-password.

import { useState, FormEvent } from 'react';
import { useLocation, useParams } from 'wouter';
import { useQuery } from '@tanstack/react-query';
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
import { useLanguage } from '@/contexts/LanguageContext';
import { LanguageSelector } from '@/components/LanguageSelector';
import { useToast } from '@/hooks/use-toast';
import { apiRequest } from '@/lib/queryClient';
import {
  Loader2,
  ArrowLeft,
  CheckCircle,
  XCircle,
  KeyRound,
  Eye,
  EyeOff,
  Lock,
  Check,
  X,
} from 'lucide-react';
import { passwordPolicy } from '@shared/schema';

export default function AdminResetPasswordPage() {
  const { token } = useParams<{ token: string }>();
  const { t, language, direction } = useLanguage();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSuccess, setIsSuccess] = useState(false);

  const { data: tokenData, isLoading, error } = useQuery({
    queryKey: ['/auth/admin/reset-password', token],
    queryFn: async () => {
      const response = await apiRequest('GET', `/auth/admin/reset-password/${token}`);
      const data = await response.json();
      if (!data.success) {
        throw new Error(data.message || 'Invalid token');
      }
      return data;
    },
    enabled: !!token,
    retry: false,
  });

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!newPassword.trim()) {
      toast({
        title: t('auth.error') || 'Error',
        description: t('auth.passwordRequired') || 'Password is required',
        variant: 'destructive',
      });
      return;
    }

    const passwordErrors: string[] = [];
    if (newPassword.length < passwordPolicy.minLength) {
      passwordErrors.push(`Password must be at least ${passwordPolicy.minLength} characters`);
    }
    if (passwordPolicy.requireUppercase && !/[A-Z]/.test(newPassword)) {
      passwordErrors.push('Password must contain at least one uppercase letter');
    }
    if (passwordPolicy.requireLowercase && !/[a-z]/.test(newPassword)) {
      passwordErrors.push('Password must contain at least one lowercase letter');
    }
    if (passwordPolicy.requireNumber && !/[0-9]/.test(newPassword)) {
      passwordErrors.push('Password must contain at least one number');
    }
    if (passwordErrors.length > 0) {
      toast({
        title: t('auth.error') || 'Error',
        description: passwordErrors[0],
        variant: 'destructive',
      });
      return;
    }

    if (newPassword !== confirmPassword) {
      toast({
        title: t('auth.error') || 'Error',
        description: t('auth.passwordMismatch') || 'Passwords do not match',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      const response = await apiRequest('POST', '/auth/admin/reset-password', {
        token,
        newPassword,
      });
      const data = await response.json();
      if (!response.ok || !data.success) {
        throw new Error(data.message || 'Failed to reset password');
      }
      setIsSuccess(true);
      toast({
        title: t('auth.passwordResetSuccess') || 'Password reset',
        description:
          t('auth.passwordResetSuccessDesc') || 'Your password has been updated successfully.',
      });
    } catch (err: any) {
      toast({
        title: t('auth.error') || 'Error',
        description: err.message || 'Failed to reset password',
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  const passwordChecks = {
    minLength: newPassword.length >= passwordPolicy.minLength,
    hasUppercase: /[A-Z]/.test(newPassword),
    hasLowercase: /[a-z]/.test(newPassword),
    hasNumber: /[0-9]/.test(newPassword),
  };

  const allRequirementsMet =
    passwordChecks.minLength &&
    (!passwordPolicy.requireUppercase || passwordChecks.hasUppercase) &&
    (!passwordPolicy.requireLowercase || passwordChecks.hasLowercase) &&
    (!passwordPolicy.requireNumber || passwordChecks.hasNumber);

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-primary mx-auto mb-4" />
          <p className="text-muted-foreground">
            {t('auth.validatingLink') || 'Validating reset link…'}
          </p>
        </div>
      </div>
    );
  }

  if (error || !tokenData) {
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
              <div className="mx-auto w-16 h-16 bg-destructive/10 rounded-full flex items-center justify-center mb-4">
                <XCircle className="w-8 h-8 text-destructive" />
              </div>
              <CardTitle className="text-2xl font-bold">
                {t('auth.invalidResetLink') || 'Invalid Reset Link'}
              </CardTitle>
              <CardDescription className="text-base">
                {t('auth.invalidResetLinkDesc') ||
                  'This password reset link is invalid or has expired. Please request a new one.'}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <Button className="w-full" onClick={() => setLocation('/admin/forgot-password')}>
                {t('auth.requestNewLink') || 'Request new link'}
              </Button>
              <Button
                variant="outline"
                className="w-full"
                onClick={() => setLocation('/admin')}
              >
                <ArrowLeft className="w-4 h-4 me-2" />
                {t('auth.backToLogin') || 'Back to Admin Sign-In'}
              </Button>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

  if (isSuccess) {
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
              <div className="mx-auto w-16 h-16 bg-green-100 dark:bg-green-900/30 rounded-full flex items-center justify-center mb-4">
                <CheckCircle className="w-8 h-8 text-green-600 dark:text-green-400" />
              </div>
              <CardTitle className="text-2xl font-bold">
                {t('auth.passwordResetSuccess') || 'Password reset'}
              </CardTitle>
              <CardDescription className="text-base">
                {t('auth.passwordResetSuccessDesc') ||
                  'Your password has been updated. You can now sign in with your new password.'}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Button className="w-full" onClick={() => setLocation('/admin')}>
                {t('auth.goToLogin') || 'Go to Admin Sign-In'}
              </Button>
            </CardContent>
          </Card>
        </main>
      </div>
    );
  }

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
            <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
              <Lock className="w-6 h-6 text-primary" />
            </div>
            <CardTitle className="text-2xl font-bold">
              {t('auth.resetPassword') || 'Reset Password'}
            </CardTitle>
            <CardDescription>
              {t('auth.resetPasswordDesc') || 'Enter your new password below.'}
            </CardDescription>
            {tokenData?.email && (
              <p className="text-sm text-muted-foreground mt-2">
                {t('auth.resettingFor') || 'Resetting password for'}: <strong>{tokenData.email}</strong>
              </p>
            )}
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="newPassword">{t('auth.newPassword') || 'New Password'}</Label>
                <div className="relative">
                  <Input
                    id="newPassword"
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder={t('auth.newPasswordPlaceholder') || 'Enter new password'}
                    required
                    dir="ltr"
                    disabled={isSubmitting}
                    className="pe-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute end-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    tabIndex={-1}
                  >
                    {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                </div>
              </div>

              <div className="space-y-2">
                <Label htmlFor="confirmPassword">
                  {t('auth.confirmPassword') || 'Confirm Password'}
                </Label>
                <Input
                  id="confirmPassword"
                  type={showPassword ? 'text' : 'password'}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder={t('auth.confirmPasswordPlaceholder') || 'Confirm new password'}
                  required
                  dir="ltr"
                  disabled={isSubmitting}
                />
                {confirmPassword && newPassword !== confirmPassword && (
                  <p className="text-xs text-destructive">
                    {t('auth.passwordMismatch') || 'Passwords do not match'}
                  </p>
                )}
              </div>

              <div className="bg-muted rounded-lg p-3 text-xs">
                <p className="font-medium mb-2 text-muted-foreground">
                  {t('auth.passwordRequirements') || 'Password requirements'}:
                </p>
                <ul className="space-y-1">
                  <li
                    className={`flex items-center gap-2 ${
                      passwordChecks.minLength
                        ? 'text-green-600 dark:text-green-400'
                        : 'text-muted-foreground'
                    }`}
                  >
                    {passwordChecks.minLength ? (
                      <Check className="w-3 h-3" />
                    ) : (
                      <X className="w-3 h-3" />
                    )}
                    At least {passwordPolicy.minLength} characters
                  </li>
                  {passwordPolicy.requireUppercase && (
                    <li
                      className={`flex items-center gap-2 ${
                        passwordChecks.hasUppercase
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {passwordChecks.hasUppercase ? (
                        <Check className="w-3 h-3" />
                      ) : (
                        <X className="w-3 h-3" />
                      )}
                      At least one uppercase letter
                    </li>
                  )}
                  {passwordPolicy.requireLowercase && (
                    <li
                      className={`flex items-center gap-2 ${
                        passwordChecks.hasLowercase
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {passwordChecks.hasLowercase ? (
                        <Check className="w-3 h-3" />
                      ) : (
                        <X className="w-3 h-3" />
                      )}
                      At least one lowercase letter
                    </li>
                  )}
                  {passwordPolicy.requireNumber && (
                    <li
                      className={`flex items-center gap-2 ${
                        passwordChecks.hasNumber
                          ? 'text-green-600 dark:text-green-400'
                          : 'text-muted-foreground'
                      }`}
                    >
                      {passwordChecks.hasNumber ? (
                        <Check className="w-3 h-3" />
                      ) : (
                        <X className="w-3 h-3" />
                      )}
                      At least one number
                    </li>
                  )}
                </ul>
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={isSubmitting || newPassword !== confirmPassword || !allRequirementsMet}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    {t('auth.resetting') || 'Resetting…'}
                  </>
                ) : (
                  <>
                    <KeyRound className="w-4 h-4 me-2" />
                    {t('auth.resetPasswordButton') || 'Reset password'}
                  </>
                )}
              </Button>
            </CardContent>
          </form>

          <CardFooter className="flex justify-center">
            <Button variant="ghost" onClick={() => setLocation('/admin')} className="text-sm">
              <ArrowLeft className="w-4 h-4 me-2" />
              {t('auth.backToLogin') || 'Back to Admin Sign-In'}
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
