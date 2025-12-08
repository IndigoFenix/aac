import { useState, useEffect, createContext, useContext, ReactNode } from 'react';
import { apiRequest, queryClient } from '@/lib/queryClient';
import { useAuth } from "@/hooks/useAuth";

export interface AacUser {
  id: string;
  name: string;
  age?: number;
  birthDate?: string;
  gender?: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
  data: any;
}

interface AacUserContextType {
  aacUser: AacUser | null;
  aacUsers: AacUser[];
  isReady: boolean;
  isLoading: boolean;
  selectAacUser: (aacUserId?: string | null) => Promise<boolean>;
  refetchAacUser: () => Promise<void>;
}

const AAC_USERS_QUERY_KEY = ['/api/aac-users'];
const aacUserDetailQueryKey = (id: string) => ['/api/aac-users', id];

const AacUserContext = createContext<AacUserContextType | null>(null);

export const useAacUser = () => {
  const context = useContext(AacUserContext);
  if (!context) {
    throw new Error('useAacUser must be used within an AacUserProvider');
  }
  return context;
};

export const AacUserProvider = ({ children }: { children: ReactNode }) => {
  const [aacUser, setAacUser] = useState<AacUser | null>(null);
  const [aacUsers, setAacUsers] = useState<AacUser[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const { user } = useAuth();

  // Load list of AAC users, with react-query + in‑memory cache
  const loadAacUsers = async (): Promise<AacUser[]> => {
    const cached = queryClient.getQueryData<AacUser[]>(AAC_USERS_QUERY_KEY);
    if (cached) {
      setAacUsers(cached);
      return cached;
    }

    try {
      const response = await apiRequest('GET', '/api/aac-users');
      const data = await response.json();

      const list: AacUser[] =
        data?.success && Array.isArray(data.aacUsers) ? data.aacUsers : [];

      setAacUsers(list);
      queryClient.setQueryData<AacUser[]>(AAC_USERS_QUERY_KEY, list);

      return list;
    } catch (error) {
      console.error('Get AAC Users failed:', error);
      setAacUsers([]);
      queryClient.setQueryData<AacUser[]>(AAC_USERS_QUERY_KEY, []);
      return [];
    }
  };

  // Main “switch” function: use cache for instant switching, then refresh from API
  const selectAacUser = async (aacUserId?: string | null): Promise<boolean> => {
    // Allow clearing the current selection
    if (!aacUserId) {
      setAacUser(null);
      if (typeof window !== 'undefined') {
        window.localStorage.removeItem('aac.currentUserId');
      }
      return true;
    }

    // Optimistic: use any cached data so switching feels instant
    const cachedDetail = queryClient.getQueryData<AacUser>(
      aacUserDetailQueryKey(aacUserId)
    );
    const cachedFromList = aacUsers.find((u) => u.id === aacUserId);
    const optimisticUser = cachedDetail ?? cachedFromList;

    if (optimisticUser) {
      setAacUser(optimisticUser);
    }

    if (typeof window !== 'undefined') {
      window.localStorage.setItem('aac.currentUserId', aacUserId);
    }

    // Always hit the API to refresh on selection
    try {
      const response = await apiRequest('GET', `/api/aac-users/${aacUserId}`);
      const data = await response.json();

      if (data?.success && data.aacUser) {
        const fresh: AacUser = data.aacUser;

        setAacUser(fresh);

        // Keep the full list in sync
        setAacUsers((prev) => {
          const idx = prev.findIndex((u) => u.id === fresh.id);
          if (idx === -1) return [...prev, fresh];
          const next = [...prev];
          next[idx] = fresh;
          return next;
        });

        // Update react‑query caches
        queryClient.setQueryData<AacUser>(aacUserDetailQueryKey(aacUserId), fresh);
        queryClient.setQueryData<AacUser[]>(AAC_USERS_QUERY_KEY, (prev) => {
          if (!prev) return [fresh];
          const idx = prev.findIndex((u) => u.id === fresh.id);
          if (idx === -1) return [...prev, fresh];
          const next = [...prev];
          next[idx] = fresh;
          return next;
        });

        return true;
      }

      return false;
    } catch (error) {
      console.error('Get AAC User failed:', error);
      return false;
    }
  };

  // Initial bootstrapping of AAC users + selected user
  const checkAacUserStatus = async () => {
    setIsLoading(true);

    try {
      const users = await loadAacUsers();

      if (!users.length) {
        setAacUser(null);
        return;
      }

      let storedId: string | null = null;
      if (typeof window !== 'undefined') {
        storedId = window.localStorage.getItem('aac.currentUserId');
      }

      if (storedId) {
        await selectAacUser(storedId);
      } else {
        const initial = users.find((u) => u.isActive) ?? users[0];
        setAacUser(initial ?? null);

        if (initial && typeof window !== 'undefined') {
          window.localStorage.setItem('aac.currentUserId', initial.id);
        }
      }
    } catch (error) {
      console.error('AAC User status check failed:', error);
      setAacUser(null);
    } finally {
      setIsLoading(false);
    }
  };

  const refetchAacUser = async () => {
    await checkAacUserStatus();
  };

  // Refresh AAC users whenever the logged-in user changes
  useEffect(() => {
    if (user) {
      checkAacUserStatus();  // user logged in → load AAC users
    } else {
      // user logged out → clear state
      setAacUsers([]);
      setAacUser(null);
    }
  }, [user]);

  const contextValue: AacUserContextType = {
    aacUser,
    aacUsers,
    isLoading,
    isReady: !isLoading && !!aacUser,
    selectAacUser,
    refetchAacUser,
  };

  return (
    <AacUserContext.Provider value={contextValue}>
      {children}
    </AacUserContext.Provider>
  );
};
