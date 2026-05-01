// src/components/admin/CrmCustomerList.tsx
// Admin viewer for CRM landing-page chat visitors.

import { useMemo, useState } from "react";
import { useLocation } from "wouter";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Loader2,
  AlertCircle,
  Mail,
  Building2,
  Briefcase,
  Globe,
  ChevronRight,
  Ban,
} from "lucide-react";
import { useCrmCustomers, type CrmCustomer } from "@/hooks/useAdminData";

const PAGE_SIZE = 25;

function formatDate(value: string | undefined | null): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function displayName(c: CrmCustomer): string {
  const parts = [c.firstName, c.lastName].filter(Boolean);
  if (parts.length) return parts.join(" ");
  if (c.email) return c.email;
  return `Anonymous · ${c.id.slice(0, 8)}`;
}

export function CrmCustomerList() {
  const [, navigate] = useLocation();
  const [search, setSearch] = useState("");
  const [country, setCountry] = useState<string>("");
  const [blocked, setBlocked] = useState<"all" | "true" | "false">("all");
  const [offset, setOffset] = useState(0);

  const filters = useMemo(
    () => ({
      search: search.trim() || undefined,
      country: country || undefined,
      blocked: blocked === "all" ? undefined : (blocked as "true" | "false"),
      limit: PAGE_SIZE,
      offset,
    }),
    [search, country, blocked, offset],
  );

  const { data, isLoading, error } = useCrmCustomers(filters);

  const total = data?.pagination.total ?? 0;
  const hasMore = data?.pagination.hasMore ?? false;

  // Distinct country codes from the current page, used to populate the
  // country filter without an extra round-trip. The codes are normalised
  // uppercase by the server, so this is safe to dedupe directly.
  const knownCountries = useMemo(() => {
    const set = new Set<string>();
    for (const c of data?.data ?? []) {
      if (c.countryCode) set.add(c.countryCode);
    }
    return Array.from(set).sort();
  }, [data]);

  const resetOffsetAnd = (fn: () => void) => {
    setOffset(0);
    fn();
  };

  return (
    <div className="space-y-4">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <h2 className="text-2xl font-bold">Potential Customers</h2>
          <p className="text-muted-foreground text-sm mt-1">
            {isLoading ? "Loading…" : `${total} ${total === 1 ? "visitor" : "visitors"}`}
          </p>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <Input
            placeholder="Search name, email, org…"
            value={search}
            onChange={(e) => resetOffsetAnd(() => setSearch(e.target.value))}
            className="w-60"
            data-testid="crm-customer-search"
          />
          <Select
            value={country || "all"}
            onValueChange={(v) => resetOffsetAnd(() => setCountry(v === "all" ? "" : v))}
          >
            <SelectTrigger className="w-32">
              <SelectValue placeholder="Country" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All countries</SelectItem>
              {knownCountries.map((c) => (
                <SelectItem key={c} value={c}>
                  {c}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select
            value={blocked}
            onValueChange={(v) => resetOffsetAnd(() => setBlocked(v as any))}
          >
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="false">Active</SelectItem>
              <SelectItem value="true">Blocked</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
        </div>
      ) : error ? (
        <div className="flex items-center gap-2 text-destructive py-8">
          <AlertCircle className="w-5 h-5" />
          <span>Failed to load customers.</span>
        </div>
      ) : (data?.data.length ?? 0) === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Globe className="w-12 h-12 mx-auto mb-4 text-muted-foreground opacity-50" />
            <p className="text-muted-foreground">No visitors match these filters yet.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-2">
          {data!.data.map((c) => (
            <Card
              key={c.id}
              className="cursor-pointer hover:border-primary transition-colors"
              onClick={() => navigate(`/admin/crm/customers/${c.id}`)}
              data-testid={`crm-customer-row-${c.id}`}
            >
              <CardContent className="p-4">
                <div className="flex items-center justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1 flex-wrap">
                      <span className="font-semibold">{displayName(c)}</span>
                      {c.isBlocked && (
                        <Badge variant="destructive" className="text-xs gap-1">
                          <Ban className="w-3 h-3" />
                          Blocked
                        </Badge>
                      )}
                      {c.countryCode && (
                        <Badge variant="outline" className="text-xs">
                          {c.countryCode}
                        </Badge>
                      )}
                      {c.scratchpad && c.scratchpad.trim().length > 0 && (
                        <Badge variant="secondary" className="text-xs">
                          notes
                        </Badge>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                      {c.email && (
                        <span className="flex items-center gap-1">
                          <Mail className="w-3.5 h-3.5" />
                          {c.email}
                        </span>
                      )}
                      {c.organization && (
                        <span className="flex items-center gap-1">
                          <Building2 className="w-3.5 h-3.5" />
                          {c.organization}
                        </span>
                      )}
                      {c.role && (
                        <span className="flex items-center gap-1">
                          <Briefcase className="w-3.5 h-3.5" />
                          {c.role}
                        </span>
                      )}
                      <span>last seen {formatDate(c.lastSeenAt)}</span>
                    </div>
                  </div>
                  <ChevronRight className="w-5 h-5 text-muted-foreground shrink-0" />
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {(offset > 0 || hasMore) && !isLoading && (
        <div className="flex items-center justify-between pt-2">
          <Button
            variant="outline"
            size="sm"
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            Previous
          </Button>
          <span className="text-xs text-muted-foreground">
            {offset + 1}–{Math.min(offset + PAGE_SIZE, total)} of {total}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={!hasMore}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
