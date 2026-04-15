// Per-student custom-app (game) assignment section for the AAC settings panel.
// Lists all custom apps in the student's institutes with a toggle for each.

import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { apiRequest } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import { useInstitute } from "@/hooks/useInstitute";
import { useToast } from "@/hooks/use-toast";
import { Gamepad2, Loader2 } from "lucide-react";

interface AACSettingsCustomAppsProps {
  studentId: string;
}

interface AvailableAppsResponse {
  apps: Array<{ id: string; name: string; description: string | null }>;
  assignedIds: string[];
}

export function AACSettingsCustomApps({ studentId }: AACSettingsCustomAppsProps) {
  const { t } = useLanguage();
  const { currentPermissions } = useInstitute();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const customAppsEnabled = !!currentPermissions?.customAppsEnabled;

  const queryKey = useMemo(
    () => ["customApps:available", studentId],
    [studentId],
  );

  const { data, isLoading, isError } = useQuery<AvailableAppsResponse>({
    queryKey,
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/custom-apps/student/${studentId}/available`);
      if (!res.ok) throw new Error("Failed to load custom apps");
      return res.json();
    },
    enabled: customAppsEnabled && !!studentId,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ appId, assigned }: { appId: string; assigned: boolean }) => {
      if (assigned) {
        const res = await apiRequest(
          "POST",
          `/api/custom-apps/${appId}/assignments`,
          { studentId },
        );
        if (!res.ok) throw new Error("Assign failed");
      } else {
        const res = await apiRequest(
          "DELETE",
          `/api/custom-apps/${appId}/assignments/${studentId}`,
        );
        if (!res.ok) throw new Error("Unassign failed");
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      toast({
        title: t("aacSettings.customApps.updateError"),
        description: String(err),
        variant: "destructive",
      });
    },
  });

  if (!customAppsEnabled) return null;

  const assigned = new Set(data?.assignedIds ?? []);
  const apps = data?.apps ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Gamepad2 className="w-5 h-5" />
          {t("aacSettings.customApps.title")}
        </CardTitle>
        <CardDescription>{t("aacSettings.customApps.description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> {t("aacSettings.customApps.loading")}
          </div>
        )}
        {isError && (
          <div className="text-sm text-destructive">{t("aacSettings.customApps.loadError")}</div>
        )}
        {!isLoading && !isError && apps.length === 0 && (
          <div className="text-sm text-muted-foreground">{t("aacSettings.customApps.empty")}</div>
        )}
        {apps.map((app) => {
          const isAssigned = assigned.has(app.id);
          return (
            <div
              key={app.id}
              className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between"
            >
              <div className="space-y-0.5">
                <Label className="text-base font-medium">{app.name}</Label>
                {app.description ? (
                  <p className="text-sm text-muted-foreground">{app.description}</p>
                ) : null}
              </div>
              <Switch
                checked={isAssigned}
                disabled={toggleMutation.isPending}
                onCheckedChange={(next) =>
                  toggleMutation.mutate({ appId: app.id, assigned: next })
                }
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
