// src/hooks/useAuth.tsx
import { useState, useEffect, useRef, createContext, useContext, ReactNode } from 'react';
import { apiRequest, queryClient, setUnauthorizedHandler } from '@/lib/queryClient';
import { toast } from '@/hooks/use-toast';
import { useLanguage } from '@/contexts/LanguageContext';
import type { LicenseStatus } from '@shared/license-status';

export interface LicensePermissions {
  all?: boolean;
  maxStudents: number;
  aacEnabled: boolean;
  boardMakerEnabled: boolean;
  unrestrictedAI: boolean;
  calendar: boolean;
  dashboardLevel: 0 | 1 | 2 | -1;
  expertAgentsCount: number;
}

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  userType: string;
  isAdmin: boolean;
  isSystemAdmin: boolean;
  credits: number;
  /** The USER's tier ('free' | 'premium' | 'enterprise') — NOT the license
   *  billing interval; userAuth reads this to decide premium. */
  subscriptionType: string | null;
  /** Billing interval of the license: 'monthly' | 'yearly'. Null when the
   *  license has no plan (admin-granted / perpetual). */
  licenseSubscriptionType?: string | null;
  profileImageUrl?: string;
  isActive: boolean;
  referralCode?: string;
  mfaEnabled?: boolean;
  mfaEnforcedByAdmin?: boolean;
  biometricDataId?: string | null;
  licensePermissions?: LicensePermissions;
  licenseType?: string;
  isTrial?: boolean;
  trialExpiresAt?: string;
  // ── Billing (per-license Paddle) ───────────────────────────────────────────
  // The license this user's access derives from. `licenseId` is null when the
  // user has no license of their own (institute members inherit the
  // institute's — see useInstitute), and the paywall keys off that: a null id
  // means there is nothing this user can buy here.
  licenseId?: string | null;
  licenseStatus?: LicenseStatus;
  /** Expiry of whichever clock applies (trial end, or paid-until). */
  licenseExpiresAt?: string | null;
  /** Integer MINOR units (cents/agorot). Null for invoice customers, who see
   *  status text and no pay button. */
  licensePriceAmount?: number | null;
  licensePriceCurrency?: string | null;
  supportSession?: { instituteId: string; startedAt: string } | null;
  // SLP MODE — a per-USER AAC session behavior (a speech-language pathologist
  // running therapy sessions WITH students). Unlike every other AAC option it
  // is NOT per-student, so it lives here on the account and follows the
  // clinician. Written via PATCH /api/profile/slp-mode.
  slpMode?: boolean;
  // Set only when the session identity is from admin_users. Array of admin
  // section keys this admin can access, with "*" meaning all sections.
  adminPermissions?: string[];
}

export interface LoginResult {
  success: boolean;
  user?: User;
  mfaRequired?: boolean;
  mfaSetupRequired?: boolean;
  mfaToken?: string;
  message?: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<LoginResult>;
  logout: () => void;
  logoutQuietly: () => Promise<void>;
  refetchUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const { t } = useLanguage();
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  // Keep a ref to the current user so the module-level 401 handler (which runs
  // outside React) can tell whether a 401 means "session expired" (was logged
  // in) vs. a normal unauthenticated request (e.g. the initial /auth/user probe
  // or the login page). Also guards against firing the logout flow repeatedly
  // when several in-flight requests all 401 at once.
  const userRef = useRef<User | null>(null);
  const sessionExpiredRef = useRef(false);
  useEffect(() => {
    userRef.current = user;
    if (user) sessionExpiredRef.current = false;
  }, [user]);

  const checkAuthStatus = async () => {
    try {
      const response = await apiRequest("GET", "/auth/user");
      if (response.ok) {
        const data = await response.json();
        if (data.success && data.user) {
          setUser(data.user);
        } else {
          setUser(null);
        }
      } else {
        setUser(null);
      }
    } catch (error) {
      console.error('Auth status check failed:', error);
      setUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  const login = async (email: string, password: string): Promise<LoginResult> => {
    try {
      const response = await apiRequest("POST", "/auth/login", {
        email,
        password,
      });

      const data = await response.json();

      // MFA required - user verified but needs second factor
      if (data.success && data.mfaRequired) {
        return {
          success: true,
          mfaRequired: true,
          mfaToken: data.mfaToken,
          message: data.message,
        };
      }

      // MFA setup required - user needs to set up MFA before proceeding
      if (data.success && data.mfaSetupRequired) {
        return {
          success: true,
          mfaSetupRequired: true,
          mfaToken: data.mfaToken,
          message: data.message,
        };
      }

      // Normal successful login
      if (data.success && data.user) {
        setUser(data.user);
        return {
          success: true,
          user: data.user,
        };
      }

      // Login failed
      return {
        success: false,
        message: data.message || 'Login failed',
      };
    } catch (error) {
      console.error('Login failed:', error);
      return {
        success: false,
        message: 'Login failed',
      };
    }
  };

  const logout = async () => {
    try {
      await apiRequest("POST", "/auth/logout", {});
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      // Clear sensitive cached data to prevent cross-user exposure
      queryClient.removeQueries({ queryKey: ['/api/interpretations'] });
      queryClient.removeQueries({ queryKey: ['/api/students'] });
      queryClient.removeQueries({ queryKey: ['/api/onboarding/status'] });
      queryClient.removeQueries({ queryKey: ['/api/invite-codes'] });

      // Clear all queries to be safe
      queryClient.clear();

      // Clear user state
      setUser(null);

      // Redirect to login page
      window.location.href = '/login';
    }
  };

  const logoutQuietly = async () => {
    try {
      await apiRequest("POST", "/auth/logout", {});
    } catch {}
    queryClient.clear();
    setUser(null);
  };
  

  const refetchUser = async () => {
    await checkAuthStatus();
  };

  useEffect(() => {
    checkAuthStatus();
  }, []);

  // Auto-logout when an authenticated session expires. Any API call that comes
  // back 401 routes through here; we only react if the user was actually logged
  // in, so initial probes and login-page traffic don't trigger a redirect.
  useEffect(() => {
    setUnauthorizedHandler(() => {
      if (!userRef.current || sessionExpiredRef.current) return;
      sessionExpiredRef.current = true;

      toast({
        title: t('auth.sessionExpired'),
        description: t('auth.sessionExpiredDesc'),
        variant: 'destructive',
      });

      // Drop all cached data so the next user can't see the previous session's
      // PHI, clear local auth state, then bounce to the login page.
      queryClient.clear();
      setUser(null);
      window.location.href = '/login';
    });

    return () => setUnauthorizedHandler(null);
  }, [t]);

  const contextValue: AuthContextType = {
    user,
    isAuthenticated: !!user,
    isLoading,
    login,
    logout,
    logoutQuietly,
    refetchUser,
  };

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
};