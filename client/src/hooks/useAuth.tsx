// src/hooks/useAuth.tsx
import { useState, useEffect, createContext, useContext, ReactNode } from 'react';
import { apiRequest, queryClient } from '@/lib/queryClient';

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
  subscriptionType: string;
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
  supportSession?: { instituteId: string; startedAt: string } | null;
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
  const [user, setUser] = useState<User | null>(null);
  const [isLoading, setIsLoading] = useState(true);

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