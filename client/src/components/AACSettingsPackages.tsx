// Per-student content-package attachment for the AAC settings panel.
//
// Attaching a package exposes its auto-loading boards to the AAC assistant and
// puts all of its boards in the student's picker.
//
// The search box does TWO things, because packages come from two places:
//   1. filters what this {{STUDENT}} can already reach (their organization's
//      packages, ones shared with them individually, ones already attached);
//   2. searches the PUBLIC library — approved packages published by other
//      organizations — so they can be found and attached at all. Nothing else
//      in the app calls that endpoint, so before this the only public packages
//      you could see were the ones that happened to already be in your list.

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CardContent } from "@/components/ui/card";
import { CollapsibleSection } from "@/components/ui/collapsible-section";
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

/** Public search only fires past this, so a single keystroke doesn't hit the API. */
const MIN_PUBLIC_SEARCH_CHARS = 2;

export function AACSettingsPackages({ studentId }: AACSettingsPackagesProps) {
  const { t } = useLanguage();
  const { currentInstitute, currentPermissions } = useInstitute();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [search, setSearch] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");

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

  // Debounce so typing doesn't fire a query per keystroke.
  useEffect(() => {
    const id = setTimeout(() => setDebouncedSearch(search.trim()), 300);
    return () => clearTimeout(id);
  }, [search]);

  const publicQueryEnabled =
    packagesEnabled && !!instituteId && debouncedSearch.length >= MIN_PUBLIC_SEARCH_CHARS;

  const { data: publicResults, isFetching: publicLoading } = useQuery<Package[]>({
    queryKey: ["packages:public-search", debouncedSearch],
    queryFn: async () => {
      // No instituteId: the public library is global by definition, and the
      // endpoint resolves the licence from the caller's own institutes.
      const params = new URLSearchParams({ q: debouncedSearch, limit: "25" });
      const res = await apiRequest("GET", `/api/packages/search?${params}`);
      return res.json();
    },
    enabled: publicQueryEnabled,
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
      // A newly attached public package now belongs in the list above, so it
      // must drop out of the discovery results.
      void queryClient.invalidateQueries({ queryKey: ["packages:public-search"] });
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
  const needle = debouncedSearch.toLowerCase();
  const visible = needle
    ? all.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          (p.description ?? "").toLowerCase().includes(needle),
      )
    : all;

  // Only offer public packages this student cannot already reach — otherwise
  // the same package would appear in both lists with two toggles.
  const known = new Set(all.map((p) => p.id));
  const discovered = (publicResults ?? []).filter((p) => !known.has(p.id));

  /** One package row. `discoverable` marks a public one not yet reachable. */
  const renderRow = (pkg: Package, discoverable = false) => {
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
          aria-label={discoverable ? t("packages.attachPublic", { name: pkg.name }) : pkg.name}
          data-testid={`package-toggle-${pkg.id}`}
        />
      </div>
    );
  };

  return (
    <CollapsibleSection
      icon={<PackageIcon className="w-5 h-5" />}
      title={t("packages.title")}
      description={t("packages.studentDescription")}
    >
      <CardContent className="space-y-4">
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
        <p className="text-xs text-muted-foreground">{t("packages.searchHelp")}</p>

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

        {visible.map((pkg) => renderRow(pkg))}

        {/* The public library. Only appears once there is a search to run, so
            the section stays quiet for clinicians who never leave their own
            organization's packages. */}
        {publicQueryEnabled && (
          <div className="space-y-4 border-t pt-4">
            <div className="space-y-0.5">
              <h4 className="text-sm font-semibold flex items-center gap-2">
                <Globe className="w-4 h-4 shrink-0 text-muted-foreground" />
                {t("packages.publicLibrary")}
              </h4>
              <p className="text-xs text-muted-foreground">
                {t("packages.publicLibraryHelp")}
              </p>
            </div>

            {publicLoading && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="w-4 h-4 animate-spin" /> {t("common.loading")}
              </div>
            )}
            {!publicLoading && discovered.length === 0 && (
              <div className="text-sm text-muted-foreground">
                {t("packages.noPublicResults")}
              </div>
            )}
            {discovered.map((pkg) => renderRow(pkg, true))}
          </div>
        )}
      </CardContent>
    </CollapsibleSection>
  );
}
