import { useQuery } from "@tanstack/react-query";
import { apiRequest } from "@/lib/queryClient";

export function useAuth() {
  const { data: user, isLoading, error } = useQuery({
    queryKey: ["/auth/user"],
    queryFn: async () => {
      try {
        const response = await apiRequest("GET", "/auth/user");
        return response.json();
      } catch (error: any) {
        if (error.message.includes("401")) {
          return null; // Not authenticated
        }
        throw error;
      }
    },
    retry: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });

  return {
    user,
    isLoading,
    error,
    isAuthenticated: !!user && !error,
    // SLP MODE is a per-LOGGED-IN-USER AAC behavior (a speech-language
    // pathologist running a session WITH the student), so it rides on the
    // current-user payload rather than any student record. `user` here is the
    // whole `{ success, user }` envelope — see useLiveSession's initialize.
    // NOTE: the live session does NOT read this; it takes the authoritative
    // value from the server's `clientConfig.slpMode`. This is for any UI that
    // needs it before/outside a session.
    slpMode: (user as any)?.user?.slpMode === true,
  };
}
