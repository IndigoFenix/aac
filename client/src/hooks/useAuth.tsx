import { useState, useEffect, createContext, useContext, ReactNode } from 'react';
import { apiRequest, queryClient } from '@/lib/queryClient';

interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  fullName: string;
  userType: string;
  isAdmin: boolean;
  credits: number;
  subscriptionType: string;
  profileImageUrl?: string;
  isActive: boolean;
  referralCode?: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<boolean>;
  logout: () => void;
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

  const login = async (email: string, password: string): Promise<boolean> => {
    try {
      const response = await apiRequest("POST", "/auth/login", {
        email,
        password,
      });

      const data = await response.json();

      if (data.success && data.user) {
        setUser(data.user);
        return true;
      } else {
        return false;
      }
    } catch (error) {
      console.error('Login failed:', error);
      return false;
    }
  };

  const logout = async () => {
    try {
      const response = await apiRequest("POST", "/auth/logout", {});
    } catch (error) {
      console.error('Logout failed:', error);
    } finally {
      // Clear sensitive cached data to prevent cross-user exposure
      queryClient.removeQueries({ queryKey: ['/api/interpretations'] });
      queryClient.removeQueries({ queryKey: ['/api/aac-users'] });
  
      // Also clear the currently selected AAC user
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('aac.currentUserId');
      }
  
      setUser(null);
      window.location.href = '/';
    }
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
    refetchUser,
  };

  return <AuthContext.Provider value={contextValue}>{children}</AuthContext.Provider>;
};