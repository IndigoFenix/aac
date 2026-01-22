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
  };
}