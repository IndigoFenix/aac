// Per-student content-package attachment for the AAC settings panel.
//
// Attaching a package exposes its auto-loading boards to the AAC assistant and
// puts all of its boards in the student's picker. Mirrors the custom-apps
// section, with a search box because the list can include public packages.

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { apiRequest } from "@/lib/queryClient";
import { useLanguage } from "@/contexts/LanguageContext";
import { useInstitute } from "@/hooks/useInstitute";
import { useToast } from "@/hooks/use-toast";
import { Globe, Loader2, Package as PackageIcon, Search } from "lucide-react";
import type { Package } from "@shared/schema";

interface AACSettingsPackagesProps {
  studentId: string;
}

interface AvailablePackagesResponse {
  packages: Package[];
  assignedIds: string[];
}

export function AACSettingsPackages({ studentId }: AACSettingsPackagesProps) {
  const { t } = useLanguage();
  const { currentInstitute, currentPermissions } = useInstitute();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");

  const packagesEnabled = !!currentPermissions?.packagesEnabled;
  const instituteId = currentInstitute?.id;
  const q = instituteId ? `?instituteId=${instituteId}` : "";

  const queryKey = useMemo(
    () => ["packages:available", studentId, instituteId],
    [studentId, instituteId],
  );

  const { data, isLoading, isError } = useQuery<AvailablePackagesResponse>({
    queryKey,
    queryFn: async () => {
      const res = await apiRequest(
        "GET",
        `/api/packages/student/${studentId}/available${q}`,
      );
      return res.json();
    },
    enabled: packagesEnabled && !!studentId && !!instituteId,
  });

  const toggleMutation = useMutation({
    mutationFn: async ({ packageId, attached }: { packageId: string; attached: boolean }) => {
      if (attached) {
        await apiRequest("POST", `/api/packages/${packageId}/assignments${q}`, { studentId });
      } else {
        await apiRequest(
          "DELETE",
          `/api/packages/${packageId}/assignments/${studentId}${q}`,
        );
      }
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey });
    },
    onError: (err) => {
      toast({
        title: t("packages.updateError"),
        description: String(err),
        variant: "destructive",
      });
    },
  });

  if (!packagesEnabled) return null;

  const assigned = new Set(data?.assignedIds ?? []);
  const all = data?.packages ?? [];
  const needle = search.trim().toLowerCase();
  const visible = needle
    ? all.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          (p.description ?? "").toLowerCase().includes(needle),
      )
    : all;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <PackageIcon className="w-5 h-5" />
          {t("packages.title")}
        </CardTitle>
        <CardDescription>{t("packages.studentDescription")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {all.length > 4 && (
          <div className="relative">
            <Search className="absolute start-2 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              className="ps-8"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("packages.searchPlaceholder")}
              aria-label={t("packages.searchPlaceholder")}
              data-testid="package-search"
            />
          </div>
        )}

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="w-4 h-4 animate-spin" /> {t("common.loading")}
          </div>
        )}
        {isError && <div className="text-sm text-destructive">{t("packages.loadError")}</div>}
        {!isLoading && !isError && all.length === 0 && (
          <div className="text-sm text-muted-foreground">{t("packages.noneAvailable")}</div>
        )}
        {!isLoading && all.length > 0 && visible.length === 0 && (
          <div className="text-sm text-muted-foreground">{t("packages.noSearchResults")}</div>
        )}

        {visible.map((pkg) => {
          const isAssigned = assigned.has(pkg.id);
          // An orphaned package can be kept and removed, never newly added.
          const frozen = pkg.deletedAt !== null;
          return (
            <div
              key={pkg.id}
              className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between"
            >
              <div className="space-y-0.5 min-w-0">
                <Label className="text-base font-medium flex items-center gap-2">
                  <span className="truncate">{pkg.name}</span>
                  {pkg.visibility === "public" && (
                    <Globe
                      className="w-3.5 h-3.5 shrink-0 text-muted-foreground"
                      aria-label={t("packages.public")}
                    />
                  )}
                </Label>
                {pkg.description ? (
                  <p className="text-sm text-muted-foreground">{pkg.description}</p>
                ) : null}
                {frozen && (
                  <p className="text-xs text-amber-600 dark:text-amber-400">
                    {t("packages.frozenShort")}
                  </p>
                )}
              </div>
              <Switch
                checked={isAssigned}
                disabled={toggleMutation.isPending || (frozen && !isAssigned)}
                onCheckedChange={(next) =>
                  toggleMutation.mutate({ packageId: pkg.id, attached: next })
                }
                aria-label={pkg.name}
                data-testid={`package-toggle-${pkg.id}`}
              />
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}
