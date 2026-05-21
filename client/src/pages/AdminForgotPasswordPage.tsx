// src/pages/AdminForgotPasswordPage.tsx
// Admin-only password reset request. Posts to /auth/admin/forgot-password.

import { useState, FormEvent } from 'react';
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
import { useLanguage } from '@/contexts/LanguageContext';
import { LanguageSelector } from '@/components/LanguageSelector';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, ServiceUnavailableError } from '@/lib/queryClient';
import { Mail, Loader2, ArrowLeft, CheckCircle, KeyRound } from 'lucide-react';

export default function AdminForgotPasswordPage() {
  const { t, language, direction } = useLanguage();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  const [email, setEmail] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();

    if (!email.trim()) {
      toast({
        title: t('auth.error') || 'Error',
        description: t('auth.emailRequired') || 'Email is required',
        variant: 'destructive',
      });
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      toast({
        title: t('auth.error') || 'Error',
        description: t('auth.invalidEmail') || 'Please enter a valid email address',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);
    try {
      await apiRequest('POST', '/auth/admin/forgot-password', {
        email: email.trim().toLowerCase(),
      });
      setIsSubmitted(true);
    } catch (error: any) {
      const isDeliveryFailure = error instanceof ServiceUnavailableError;
      toast({
        title: t('auth.error') || 'Error',
        description: isDeliveryFailure
          ? (t('auth.resetEmailFailed') ||
            'Could not send the reset email. Please try again later or contact support.')
          : (error?.message ||
            t('auth.resetEmailFailed') ||
            'Could not send the reset email. Please try again later.'),
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isSubmitted) {
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
                {t('auth.checkEmail') || 'Check Your Email'}
              </CardTitle>
              <CardDescription className="text-base">
                {t('admin.resetEmailSent') ||
                  "If an admin account exists with this email, we've sent a password reset link."}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="bg-muted rounded-lg p-4 text-sm text-muted-foreground">
                <p className="mb-2">
                  <strong>{t('auth.sentTo') || 'Sent to'}:</strong> {email}
                </p>
                <p>
                  {t('auth.checkSpam') ||
                    "Don't see it? Check your spam folder or try again with a different email."}
                </p>
              </div>

              <div className="space-y-2">
                <Button
                  variant="outline"
                  className="w-full"
                  onClick={() => {
                    setIsSubmitted(false);
                    setEmail('');
                  }}
                >
                  <Mail className="w-4 h-4 me-2" />
                  {t('auth.tryDifferentEmail') || 'Try a different email'}
                </Button>

                <Button className="w-full" onClick={() => setLocation('/admin')}>
                  <ArrowLeft className="w-4 h-4 me-2" />
                  {t('auth.backToLogin') || 'Back to Admin Sign-In'}
                </Button>
              </div>
            </CardContent>
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
              <KeyRound className="w-6 h-6 text-primary" />
            </div>
            <CardTitle className="text-2xl font-bold">
              {t('admin.forgotPassword') || 'Reset Admin Password'}
            </CardTitle>
            <CardDescription>
              {t('admin.forgotPasswordDesc') ||
                "Enter your admin email and we'll send a reset link."}
            </CardDescription>
          </CardHeader>

          <form onSubmit={handleSubmit}>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="email">{t('auth.email') || 'Email'}</Label>
                <Input
                  id="email"
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder={t('auth.emailPlaceholder') || 'Enter your email'}
                  required
                  dir="ltr"
                  disabled={isSubmitting}
                />
              </div>

              <Button type="submit" className="w-full" disabled={isSubmitting}>
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    {t('auth.sending') || 'Sending…'}
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4 me-2" />
                    {t('auth.sendResetLink') || 'Send reset link'}
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
