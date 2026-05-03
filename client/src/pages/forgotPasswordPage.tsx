// src/pages/ForgotPasswordPage.tsx
// Page for requesting a password reset email

import { useState, FormEvent } from 'react';
import { useLocation } from 'wouter';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card';
import { useLanguage } from '@/contexts/LanguageContext';
import { LanguageSelector } from '@/components/LanguageSelector';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, ServiceUnavailableError } from '@/lib/queryClient';
import { 
  Mail, 
  Loader2, 
  ArrowLeft, 
  CheckCircle,
  KeyRound,
} from 'lucide-react';

export default function ForgotPasswordPage() {
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

    // Basic email validation
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
      await apiRequest('POST', '/auth/forgot-password', {
        email: email.trim().toLowerCase(),
      });
      setIsSubmitted(true);
    } catch (error: any) {
      // The endpoint returns 200 in the user-doesn't-exist and send-succeeded
      // cases (deliberate, for security), and 502 only when the SMTP send
      // itself failed. apiRequest() turns 502/503/504 into
      // ServiceUnavailableError — surface that distinctly so the operator
      // knows it's a delivery problem, not a generic network failure.
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

  // Success state after submission
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
                {t('auth.resetEmailSent') || 
                  'If an account exists with this email, we\'ve sent a password reset link.'}
              </CardDescription>
            </CardHeader>

            <CardContent className="space-y-4">
              <div className="bg-muted rounded-lg p-4 text-sm text-muted-foreground">
                <p className="mb-2">
                  <strong>{t('auth.sentTo') || 'Sent to'}:</strong> {email}
                </p>
                <p>
                  {t('auth.checkSpam') || 
                    'Don\'t see it? Check your spam folder or try again with a different email.'}
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

                <Button
                  className="w-full"
                  onClick={() => setLocation('/login')}
                >
                  <ArrowLeft className="w-4 h-4 me-2" />
                  {t('auth.backToLogin') || 'Back to Login'}
                </Button>
              </div>
            </CardContent>
          </Card>
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
        </footer>
      </div>
    );
  }

  // Request form
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
              {t('auth.forgotPassword') || 'Forgot Password?'}
            </CardTitle>
            <CardDescription>
              {t('auth.forgotPasswordDesc') || 
                'Enter your email address and we\'ll send you a link to reset your password.'}
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
                  autoFocus
                />
              </div>

              <Button
                type="submit"
                className="w-full"
                disabled={isSubmitting}
              >
                {isSubmitting ? (
                  <>
                    <Loader2 className="w-4 h-4 me-2 animate-spin" />
                    {t('auth.sending') || 'Sending...'}
                  </>
                ) : (
                  <>
                    <Mail className="w-4 h-4 me-2" />
                    {t('auth.sendResetLink') || 'Send Reset Link'}
                  </>
                )}
              </Button>
            </CardContent>
          </form>

          <CardFooter className="flex justify-center">
            <Button
              variant="ghost"
              onClick={() => setLocation('/login')}
              className="text-sm"
            >
              <ArrowLeft className="w-4 h-4 me-2" />
              {t('auth.backToLogin') || 'Back to Login'}
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