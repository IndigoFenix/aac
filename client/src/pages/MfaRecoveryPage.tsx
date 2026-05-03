// src/pages/MfaRecoveryPage.tsx
// Page for MFA recovery - request and complete recovery

import { useState, FormEvent, useEffect } from 'react';
import { useLocation, useParams } from 'wouter';
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
import { Alert, AlertDescription } from '@/components/ui/alert';
import { useLanguage } from '@/contexts/LanguageContext';
import { LanguageSelector } from '@/components/LanguageSelector';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, ServiceUnavailableError } from '@/lib/queryClient';
import { Loader2, ShieldOff, Mail, CheckCircle, AlertTriangle } from 'lucide-react';

export default function MfaRecoveryPage() {
  const params = useParams<{ token?: string }>();
  const token = params.token;
  const isCompleteMode = !!token;

  const { t, direction } = useLanguage();
  const { toast } = useToast();
  const [, setLocation] = useLocation();

  // Request mode state
  const [email, setEmail] = useState('');
  const [isRequesting, setIsRequesting] = useState(false);
  const [requestSent, setRequestSent] = useState(false);

  // Complete mode state
  const [isValidating, setIsValidating] = useState(true);
  const [isValid, setIsValid] = useState(false);
  const [maskedEmail, setMaskedEmail] = useState<string | null>(null);
  const [isCompleting, setIsCompleting] = useState(false);
  const [isCompleted, setIsCompleted] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Validate token on mount if in complete mode
  useEffect(() => {
    if (isCompleteMode && token) {
      validateToken(token);
    }
  }, [isCompleteMode, token]);

  const validateToken = async (token: string) => {
    setIsValidating(true);
    setError(null);
    try {
      const response = await apiRequest('GET', `/auth/mfa/recovery/${token}`);
      const data = await response.json();

      if (data.success) {
        setIsValid(true);
        setMaskedEmail(data.email);
      } else {
        setIsValid(false);
        setError(data.message || 'Invalid or expired recovery link');
      }
    } catch {
      setIsValid(false);
      setError('Failed to validate recovery link');
    } finally {
      setIsValidating(false);
    }
  };

  const handleRequestRecovery = async (e: FormEvent) => {
    e.preventDefault();

    if (!email.trim()) {
      toast({
        title: 'Error',
        description: 'Please enter your email address',
        variant: 'destructive',
      });
      return;
    }

    setIsRequesting(true);
    try {
      await apiRequest('POST', '/auth/mfa/recovery/request', {
        email: email.trim(),
      });
      setRequestSent(true);
    } catch (error: any) {
      // 502/503/504 → ServiceUnavailableError means SMTP delivery failed.
      // Surface that distinctly; user-existence still stays hidden because
      // the no-user and send-succeeded paths both return 200.
      if (error instanceof ServiceUnavailableError) {
        toast({
          title: 'Error',
          description:
            'Could not send the recovery email. Please try again later or contact support.',
          variant: 'destructive',
        });
      } else {
        // For other errors (network, unexpected), still hide user existence.
        setRequestSent(true);
      }
    } finally {
      setIsRequesting(false);
    }
  };

  const handleCompleteRecovery = async () => {
    if (!token) return;

    setIsCompleting(true);
    try {
      const response = await apiRequest('POST', '/auth/mfa/recovery/complete', {
        token,
      });
      const data = await response.json();

      if (data.success) {
        setIsCompleted(true);
        toast({
          title: 'MFA Disabled',
          description: 'You can now log in with your password.',
        });
      } else {
        setError(data.message || 'Failed to complete recovery');
      }
    } catch {
      setError('Failed to complete recovery');
    } finally {
      setIsCompleting(false);
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
          {/* Complete Mode - Validating */}
          {isCompleteMode && isValidating && (
            <>
              <CardHeader className="space-y-1 text-center">
                <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                  <Loader2 className="w-6 h-6 text-primary animate-spin" />
                </div>
                <CardTitle className="text-2xl font-bold">
                  Validating Recovery Link
                </CardTitle>
                <CardDescription>Please wait...</CardDescription>
              </CardHeader>
            </>
          )}

          {/* Complete Mode - Invalid Token */}
          {isCompleteMode && !isValidating && !isValid && (
            <>
              <CardHeader className="space-y-1 text-center">
                <div className="mx-auto w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center mb-4">
                  <AlertTriangle className="w-6 h-6 text-destructive" />
                </div>
                <CardTitle className="text-2xl font-bold">
                  Invalid Recovery Link
                </CardTitle>
                <CardDescription>{error}</CardDescription>
              </CardHeader>
              <CardFooter className="flex justify-center">
                <Button variant="outline" onClick={() => setLocation('/mfa-recovery')}>
                  Request New Recovery Link
                </Button>
              </CardFooter>
            </>
          )}

          {/* Complete Mode - Valid Token, Confirm */}
          {isCompleteMode && !isValidating && isValid && !isCompleted && (
            <>
              <CardHeader className="space-y-1 text-center">
                <div className="mx-auto w-12 h-12 bg-destructive/10 rounded-full flex items-center justify-center mb-4">
                  <ShieldOff className="w-6 h-6 text-destructive" />
                </div>
                <CardTitle className="text-2xl font-bold">
                  Disable Two-Factor Authentication
                </CardTitle>
                <CardDescription>
                  Are you sure you want to disable MFA for{' '}
                  <strong>{maskedEmail}</strong>?
                </CardDescription>
              </CardHeader>

              <CardContent className="space-y-4">
                <Alert>
                  <AlertTriangle className="h-4 w-4" />
                  <AlertDescription>
                    This will reduce the security of your account. You can
                    re-enable MFA at any time from your settings.
                  </AlertDescription>
                </Alert>
              </CardContent>

              <CardFooter className="flex gap-3 justify-center">
                <Button
                  variant="destructive"
                  onClick={handleCompleteRecovery}
                  disabled={isCompleting}
                >
                  {isCompleting ? (
                    <>
                      <Loader2 className="w-4 h-4 animate-spin me-2" />
                      Disabling...
                    </>
                  ) : (
                    'Disable MFA'
                  )}
                </Button>
                <Button variant="outline" onClick={() => setLocation('/login')}>
                  Cancel
                </Button>
              </CardFooter>
            </>
          )}

          {/* Complete Mode - Success */}
          {isCompleteMode && isCompleted && (
            <>
              <CardHeader className="space-y-1 text-center">
                <div className="mx-auto w-12 h-12 bg-green-500/10 rounded-full flex items-center justify-center mb-4">
                  <CheckCircle className="w-6 h-6 text-green-500" />
                </div>
                <CardTitle className="text-2xl font-bold">
                  MFA Disabled Successfully
                </CardTitle>
                <CardDescription>
                  You can now log in with your password.
                </CardDescription>
              </CardHeader>
              <CardFooter className="flex justify-center">
                <Button onClick={() => setLocation('/login')}>
                  Go to Login
                </Button>
              </CardFooter>
            </>
          )}

          {/* Request Mode - Form */}
          {!isCompleteMode && !requestSent && (
            <>
              <CardHeader className="space-y-1 text-center">
                <div className="mx-auto w-12 h-12 bg-primary/10 rounded-full flex items-center justify-center mb-4">
                  <Mail className="w-6 h-6 text-primary" />
                </div>
                <CardTitle className="text-2xl font-bold">
                  MFA Recovery
                </CardTitle>
                <CardDescription>
                  Lost access to your authenticator app? Enter your email to
                  receive a recovery link.
                </CardDescription>
              </CardHeader>

              <form onSubmit={handleRequestRecovery}>
                <CardContent className="space-y-4">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email Address</Label>
                    <Input
                      id="email"
                      type="email"
                      value={email}
                      onChange={(e) => setEmail(e.target.value)}
                      placeholder="Enter your email"
                      required
                      dir="ltr"
                      disabled={isRequesting}
                    />
                  </div>

                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isRequesting}
                  >
                    {isRequesting ? (
                      <>
                        <Loader2 className="w-4 h-4 animate-spin me-2" />
                        Sending...
                      </>
                    ) : (
                      'Send Recovery Link'
                    )}
                  </Button>
                </CardContent>
              </form>

              <CardFooter className="flex justify-center">
                <button
                  type="button"
                  onClick={() => setLocation('/login')}
                  className="text-sm text-muted-foreground hover:text-primary hover:underline"
                >
                  Back to Login
                </button>
              </CardFooter>
            </>
          )}

          {/* Request Mode - Success */}
          {!isCompleteMode && requestSent && (
            <>
              <CardHeader className="space-y-1 text-center">
                <div className="mx-auto w-12 h-12 bg-green-500/10 rounded-full flex items-center justify-center mb-4">
                  <CheckCircle className="w-6 h-6 text-green-500" />
                </div>
                <CardTitle className="text-2xl font-bold">
                  Check Your Email
                </CardTitle>
                <CardDescription>
                  If an account with MFA exists for <strong>{email}</strong>, a
                  recovery link has been sent.
                </CardDescription>
              </CardHeader>

              <CardContent>
                <p className="text-sm text-muted-foreground text-center">
                  The link will expire in 1 hour. Check your spam folder if you
                  don't see it.
                </p>
              </CardContent>

              <CardFooter className="flex flex-col gap-3">
                <Button
                  variant="outline"
                  onClick={() => {
                    setRequestSent(false);
                    setEmail('');
                  }}
                >
                  Try a Different Email
                </Button>
                <button
                  type="button"
                  onClick={() => setLocation('/login')}
                  className="text-sm text-muted-foreground hover:text-primary hover:underline"
                >
                  Back to Login
                </button>
              </CardFooter>
            </>
          )}
        </Card>
      </main>

      <footer className="p-4 text-center text-sm text-muted-foreground">
        CliniAACian
      </footer>
    </div>
  );
}
