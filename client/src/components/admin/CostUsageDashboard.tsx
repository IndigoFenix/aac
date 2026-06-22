// src/components/admin/CostUsageDashboard.tsx
// Admin "Cost & Usage" dashboard. AAC student sessions and non-AAC clinician
// chat sessions are too different to compare, so they live in separate tabs
// with their own KPIs and charts. AAC is grouped by student; chat by user
// (institute is available as a secondary grouping in both). Derived entirely
// from existing chat_sessions data.
//
// Admin-only backoffice page — strings stay in English (no i18n), matching the
// rest of the admin components.

import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { DollarSign, Clock, Gauge, Ghost, Loader2 } from "lucide-react";
import {
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  BarChart,
  Bar,
  LineChart,
  Line,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  Legend,
} from "recharts";
import { useCostUsage, type CostUsagePoint, type CostUsageKpiSet } from "@/hooks/useCostUsage";

// ---------- Helpers ----------

type GroupBy = "student" | "user" | "institute";

const PALETTE = [
  "#2563eb", "#16a34a", "#ea580c", "#9333ea", "#dc2626",
  "#0891b2", "#ca8a04", "#db2777", "#4f46e5", "#65a30d",
];
const OTHER_COLOR = "#94a3b8";
const DOW_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function fmtMoney(n: number, digits = 2): string {
  return `$${n.toFixed(digits)}`;
}

function fmtHours(seconds: number): string {
  const h = seconds / 3600;
  if (h < 1) return `${Math.round(seconds / 60)}m`;
  return `${h.toFixed(1)}h`;
}

function groupLabel(p: CostUsagePoint, by: GroupBy): string {
  if (by === "student") return p.studentName ?? "No student";
  if (by === "user") return p.userName ?? "No user";
  return p.instituteName ?? "No institute";
}

function groupByTitle(by: GroupBy): string {
  return by === "student" ? "Student" : by === "user" ? "User" : "Institute";
}

// ---------- Provider attribution ----------
//
// Maps a cost_breakdown category to the LLM provider that billed it. This is a
// business rule (not stored), kept here so it's easy to tweak:
//  - AAC sessions run on Google, EXCEPT the Monitor agent (Claude) and image
//    generation (OpenAI).
//  - Clinician chat runs on Claude, EXCEPT image generation (OpenAI).
type Provider = "Google" | "Anthropic (Claude)" | "OpenAI";

const PROVIDER_COLORS: Record<Provider, string> = {
  Google: "#4285f4",
  "Anthropic (Claude)": "#d97757",
  OpenAI: "#10a37f",
};

function categoryProvider(source: "aac" | "chat", category: string): Provider {
  const c = category.toLowerCase();
  if (c.includes("image")) return "OpenAI";
  if (source === "chat") return "Anthropic (Claude)";
  if (c.includes("monitor")) return "Anthropic (Claude)";
  return "Google";
}

/** "board-manager" -> "Board Manager", "tool:generate_image" -> "Tool: Generate Image". */
function prettyCategory(cat: string): string {
  const t = cat.replace(/^tool:/, "tool: ").replace(/[-_]/g, " ");
  return t.replace(/\b\w/g, (m) => m.toUpperCase());
}

/** Local YYYY-MM-DD for a Date (matches the <input type="date"> format). */
function localIsoDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Local YYYY-MM-DD key for a session start (ISO string in). */
function dayKey(iso: string): string {
  return localIsoDay(new Date(iso));
}

// ---------- KPI cards ----------

function KpiCard({
  icon: Icon,
  label,
  value,
  hint,
}: {
  icon: typeof DollarSign;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card>
      <CardContent className="pt-6">
        <div className="flex items-center justify-between">
          <div>
            <p className="text-sm text-muted-foreground">{label}</p>
            <p className="text-2xl font-bold">{value}</p>
            {hint && <p className="text-xs text-muted-foreground mt-1">{hint}</p>}
          </div>
          <Icon className="w-8 h-8 text-muted-foreground/50" />
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Density heatmap (day-of-week × hour) ----------

function DensityHeatmap({ points, accent }: { points: CostUsagePoint[]; accent: string }) {
  const { matrix, max } = useMemo(() => {
    const m: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
    let mx = 0;
    for (const p of points) {
      const d = new Date(p.started);
      const dow = d.getDay();
      const hr = d.getHours();
      m[dow][hr] += 1;
      if (m[dow][hr] > mx) mx = m[dow][hr];
    }
    return { matrix: m, max: mx };
  }, [points]);

  const cellColor = (v: number): string => {
    if (v === 0) return "hsl(var(--muted))";
    const intensity = max > 0 ? v / max : 0;
    const alpha = 0.15 + intensity * 0.85;
    return `color-mix(in srgb, ${accent} ${Math.round(alpha * 100)}%, transparent)`;
  };

  return (
    <div className="overflow-x-auto">
      <div className="inline-block min-w-full">
        {/* Hour header */}
        <div className="flex">
          <div className="w-10 shrink-0" />
          {Array.from({ length: 24 }, (_, h) => (
            <div key={h} className="flex-1 text-center text-[9px] text-muted-foreground min-w-[14px]">
              {h % 3 === 0 ? h : ""}
            </div>
          ))}
        </div>
        {matrix.map((row, dow) => (
          <div key={dow} className="flex items-center">
            <div className="w-10 shrink-0 text-xs text-muted-foreground pe-1 text-end">{DOW_LABELS[dow]}</div>
            {row.map((v, h) => (
              <div
                key={h}
                className="flex-1 aspect-square min-w-[14px] rounded-sm border border-background"
                style={{ backgroundColor: cellColor(v) }}
                title={`${DOW_LABELS[dow]} ${h}:00 — ${v} session${v === 1 ? "" : "s"}`}
              />
            ))}
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground mt-2">Sessions by day of week and hour of day (local time). Darker = busier.</p>
    </div>
  );
}

// ---------- Per session-type panel ----------

function SessionTypePanel({
  source,
  points,
  kpis,
  categoryBreakdown,
  groupOptions,
  defaultGroup,
  accent,
  emptyLabel,
  showGhost,
}: {
  source: "aac" | "chat";
  points: CostUsagePoint[];
  kpis: CostUsageKpiSet;
  categoryBreakdown: Record<string, number>;
  groupOptions: GroupBy[];
  defaultGroup: GroupBy;
  accent: string;
  emptyLabel: string;
  // Ghost sessions (≤1 min) are only meaningful for AAC, where they flag
  // accidental device openings. Hidden for clinician chat.
  showGhost: boolean;
}) {
  const [groupBy, setGroupBy] = useState<GroupBy>(defaultGroup);

  // Cost split by provider (Google / Anthropic / OpenAI) and by category.
  const providerData = useMemo(() => {
    const totals = new Map<Provider, number>();
    for (const [cat, amt] of Object.entries(categoryBreakdown)) {
      const p = categoryProvider(source, cat);
      totals.set(p, (totals.get(p) ?? 0) + amt);
    }
    return Array.from(totals.entries())
      .filter(([, v]) => v > 0)
      .map(([name, value]) => ({ name, value: +value.toFixed(4) }))
      .sort((a, b) => b.value - a.value);
  }, [categoryBreakdown, source]);

  const categoryData = useMemo(
    () =>
      Object.entries(categoryBreakdown)
        .filter(([, v]) => v > 0)
        .map(([cat, value]) => ({
          name: prettyCategory(cat),
          provider: categoryProvider(source, cat),
          value: +value.toFixed(4),
        }))
        .sort((a, b) => b.value - a.value),
    [categoryBreakdown, source],
  );

  const scatter = useMemo(
    () => points.map((p) => ({ x: +(p.durationSec / 60).toFixed(2), y: +p.cost.toFixed(4) })),
    [points],
  );

  const daily = useMemo(() => {
    const map = new Map<string, { date: string; cost: number; seconds: number }>();
    for (const p of points) {
      const k = dayKey(p.started);
      const row = map.get(k) ?? { date: k, cost: 0, seconds: 0 };
      row.cost += p.cost;
      row.seconds += p.durationSec;
      map.set(k, row);
    }
    return Array.from(map.values())
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((r) => ({
        date: r.date.slice(5),
        cost: +r.cost.toFixed(2),
        costPerMin: r.seconds > 0 ? +(r.cost / (r.seconds / 60)).toFixed(3) : 0,
      }));
  }, [points]);

  const histogram = useMemo(() => {
    const buckets = [
      { label: "0–1m", min: 0, max: 60, count: 0 },
      { label: "1–5m", min: 60, max: 300, count: 0 },
      { label: "5–20m", min: 300, max: 1200, count: 0 },
      { label: "20–60m", min: 1200, max: 3600, count: 0 },
      { label: "1h+", min: 3600, max: Infinity, count: 0 },
    ];
    for (const p of points) {
      const b = buckets.find((bk) => p.durationSec >= bk.min && p.durationSec < bk.max);
      if (b) b.count += 1;
    }
    return buckets.map((b) => ({ label: b.label, count: b.count }));
  }, [points]);

  const groups = useMemo(() => {
    const map = new Map<string, { name: string; cost: number; seconds: number; sessions: number }>();
    for (const p of points) {
      const name = groupLabel(p, groupBy);
      const row = map.get(name) ?? { name, cost: 0, seconds: 0, sessions: 0 };
      row.cost += p.cost;
      row.seconds += p.durationSec;
      row.sessions += 1;
      map.set(name, row);
    }
    return Array.from(map.values()).sort((a, b) => b.cost - a.cost);
  }, [points, groupBy]);

  const topGroupNames = useMemo(() => groups.slice(0, 8).map((g) => g.name), [groups]);

  const stackedDaily = useMemo(() => {
    const topSet = new Set(topGroupNames);
    const byDay = new Map<string, Record<string, number>>();
    for (const p of points) {
      const k = dayKey(p.started).slice(5);
      const series = topSet.has(groupLabel(p, groupBy)) ? groupLabel(p, groupBy) : "Other";
      const row = byDay.get(k) ?? { date: k };
      row[series] = (row[series] ?? 0) + p.durationSec / 60;
      byDay.set(k, row);
    }
    return Array.from(byDay.values())
      .map((row) => {
        const out: Record<string, any> = { date: row.date };
        for (const k of Object.keys(row)) {
          out[k] = k === "date" ? row[k] : +(row[k] as number).toFixed(1);
        }
        return out;
      })
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [points, groupBy, topGroupNames]);

  const stackSeries = useMemo(() => {
    const hasOther = groups.length > topGroupNames.length;
    return [...topGroupNames, ...(hasOther ? ["Other"] : [])];
  }, [groups, topGroupNames]);

  const pieData = useMemo(
    () => groups.slice(0, 9).map((g) => ({ name: g.name, value: +g.cost.toFixed(2) })),
    [groups],
  );

  const avgCostPerMin = kpis.totalSeconds > 0 ? kpis.totalSpend / (kpis.totalSeconds / 60) : 0;
  const groupTitle = groupByTitle(groupBy);

  if (points.length === 0 && kpis.sessionCount === 0) {
    return <p className="text-sm text-muted-foreground py-12 text-center">{emptyLabel}</p>;
  }

  return (
    <div className="space-y-6">
      {/* KPIs */}
      <div className={`grid grid-cols-1 sm:grid-cols-2 gap-4 ${showGhost ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
        <KpiCard icon={DollarSign} label="Total Spend" value={fmtMoney(kpis.totalSpend)} hint={`${kpis.sessionCount} sessions`} />
        <KpiCard icon={Clock} label="Total Active Time" value={fmtHours(kpis.totalSeconds)} />
        <KpiCard icon={Gauge} label="Avg Cost / Min" value={fmtMoney(avgCostPerMin, 3)} />
        {showGhost && (
          <KpiCard icon={Ghost} label="Ghost Sessions" value={String(kpis.ghostCount)} hint="≤ 1 minute long" />
        )}
      </div>

      {/* Cost row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Cost vs. Duration</CardTitle>
            <CardDescription>Each point is one session. X: duration (min), Y: cost.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <ScatterChart margin={{ top: 8, right: 16, bottom: 16, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" dataKey="x" name="Duration" unit="m" fontSize={12} />
                <YAxis type="number" dataKey="y" name="Cost" unit="$" fontSize={12} />
                <ZAxis range={[40, 40]} />
                <Tooltip cursor={{ strokeDasharray: "3 3" }} formatter={(v: number, n) => (n === "Cost" ? fmtMoney(v, 4) : `${v}m`)} />
                <Scatter name="Sessions" data={scatter} fill={accent} fillOpacity={0.55} />
              </ScatterChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Total Spend Over Time</CardTitle>
            <CardDescription>Daily accumulated cost.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={daily} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" fontSize={12} />
                <YAxis fontSize={12} />
                <Tooltip formatter={(v: number) => fmtMoney(v)} />
                <Bar dataKey="cost" name="Cost" fill={accent} />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Average Cost per Minute</CardTitle>
          <CardDescription>Cost efficiency tracked day by day.</CardDescription>
        </CardHeader>
        <CardContent>
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={daily} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" />
              <XAxis dataKey="date" fontSize={12} />
              <YAxis fontSize={12} />
              <Tooltip formatter={(v: number) => fmtMoney(v, 3)} />
              <Line type="monotone" dataKey="costPerMin" name="Cost/min" stroke="#ea580c" strokeWidth={2} dot={false} />
            </LineChart>
          </ResponsiveContainer>
        </CardContent>
      </Card>

      {/* Cost breakdown by provider + category */}
      {providerData.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Cost by Provider</CardTitle>
              <CardDescription>
                {source === "aac"
                  ? "AAC runs on Google; Monitor on Claude; image generation on OpenAI."
                  : "Chat runs on Claude; image generation on OpenAI."}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={280}>
                <PieChart>
                  <Pie data={providerData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={(e: any) => e.name}>
                    {providerData.map((d) => (
                      <Cell key={d.name} fill={PROVIDER_COLORS[d.name as Provider]} />
                    ))}
                  </Pie>
                  <Tooltip formatter={(v: number) => fmtMoney(v, 4)} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Cost by Category</CardTitle>
              <CardDescription>Per-agent / per-function cost, colored by provider.</CardDescription>
            </CardHeader>
            <CardContent>
              <ResponsiveContainer width="100%" height={Math.max(280, categoryData.length * 28 + 40)}>
                <BarChart data={categoryData} layout="vertical" margin={{ top: 8, right: 24, bottom: 8, left: 8 }}>
                  <CartesianGrid strokeDasharray="3 3" horizontal={false} />
                  <XAxis type="number" fontSize={12} />
                  <YAxis type="category" dataKey="name" width={130} fontSize={11} />
                  <Tooltip formatter={(v: number) => fmtMoney(v, 4)} />
                  <Bar dataKey="value" name="Cost">
                    {categoryData.map((d) => (
                      <Cell key={d.name} fill={PROVIDER_COLORS[d.provider]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Usage row */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Session Length Distribution</CardTitle>
            <CardDescription>How long sessions run.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={260}>
              <BarChart data={histogram} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="label" fontSize={12} />
                <YAxis fontSize={12} allowDecimals={false} />
                <Tooltip />
                <Bar dataKey="count" name="Sessions" fill="#9333ea" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Daily Usage Density</CardTitle>
            <CardDescription>When sessions happen.</CardDescription>
          </CardHeader>
          <CardContent>
            <DensityHeatmap points={points} accent={accent} />
          </CardContent>
        </Card>
      </div>

      {/* Comparison */}
      <div className="flex items-center gap-3">
        <h2 className="text-lg font-semibold">Comparison</h2>
        {groupOptions.length > 1 && (
          <Select value={groupBy} onValueChange={(v) => setGroupBy(v as GroupBy)}>
            <SelectTrigger className="w-44 h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {groupOptions.map((g) => (
                <SelectItem key={g} value={g}>By {groupByTitle(g)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Total Minutes per Day</CardTitle>
            <CardDescription>Active minutes, stacked by {groupTitle.toLowerCase()}.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={stackedDaily} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis dataKey="date" fontSize={12} />
                <YAxis fontSize={12} />
                <Tooltip formatter={(v: number) => `${v}m`} />
                <Legend />
                {stackSeries.map((name, i) => (
                  <Bar
                    key={name}
                    dataKey={name}
                    stackId="m"
                    fill={name === "Other" ? OTHER_COLOR : PALETTE[i % PALETTE.length]}
                  />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Cost Contribution</CardTitle>
            <CardDescription>Share of total cost by {groupTitle.toLowerCase()}.</CardDescription>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={(e: any) => e.name}>
                  {pieData.map((_, i) => (
                    <Cell key={i} fill={PALETTE[i % PALETTE.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(v: number) => fmtMoney(v)} />
              </PieChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Efficiency Leaderboard</CardTitle>
          <CardDescription>{groupTitle} comparison by cost, time, and cost/min.</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{groupTitle}</TableHead>
                <TableHead className="text-right">Sessions</TableHead>
                <TableHead className="text-right">Active Time</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">Cost / Min</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {groups.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center text-muted-foreground py-8">
                    No sessions in range.
                  </TableCell>
                </TableRow>
              ) : (
                groups.map((g) => {
                  const cpm = g.seconds > 0 ? g.cost / (g.seconds / 60) : 0;
                  return (
                    <TableRow key={g.name}>
                      <TableCell className="font-medium">{g.name}</TableCell>
                      <TableCell className="text-right">{g.sessions}</TableCell>
                      <TableCell className="text-right">{fmtHours(g.seconds)}</TableCell>
                      <TableCell className="text-right">{fmtMoney(g.cost)}</TableCell>
                      <TableCell className="text-right">
                        <Badge variant="outline">{fmtMoney(cpm, 3)}</Badge>
                      </TableCell>
                    </TableRow>
                  );
                })
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

// ---------- Main ----------

export function CostUsageDashboard() {
  // Default to the last 7 days.
  const [startDate, setStartDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() - 7);
    return localIsoDay(d);
  });
  const [endDate, setEndDate] = useState(() => localIsoDay(new Date()));

  const { data, isLoading } = useCostUsage({
    startDate: startDate || undefined,
    endDate: endDate || undefined,
  });

  const points = data?.points ?? [];
  const aacPoints = useMemo(() => points.filter((p) => p.source === "aac"), [points]);
  const chatPoints = useMemo(() => points.filter((p) => p.source === "chat"), [points]);
  const emptyKpi: CostUsageKpiSet = { sessionCount: 0, totalSpend: 0, totalSeconds: 0, ghostCount: 0 };

  // Quick date-range presets (sets local From/To inputs).
  const applyPreset = (days: number | null) => {
    if (days === null) {
      setStartDate("");
      setEndDate("");
      return;
    }
    const end = new Date();
    const start = new Date();
    start.setDate(start.getDate() - days);
    setStartDate(localIsoDay(start));
    setEndDate(localIsoDay(end));
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold">Cost &amp; Usage</h1>
          <p className="text-sm text-muted-foreground">
            AAC and chat sessions are tracked separately.{" "}
            {data?.truncated && (
              <span className="text-amber-600">Charts show a capped sample of sessions; KPIs are exact.</span>
            )}
          </p>
        </div>
        <div className="flex items-end gap-3 flex-wrap">
          <div className="flex flex-col gap-1">
            <label htmlFor="cu-start" className="text-xs text-muted-foreground">From</label>
            <Input id="cu-start" type="date" className="w-40 h-9" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <label htmlFor="cu-end" className="text-xs text-muted-foreground">To</label>
            <Input id="cu-end" type="date" className="w-40 h-9" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
          </div>
          <div className="flex gap-1">
            <Button variant="outline" size="sm" onClick={() => applyPreset(7)}>7d</Button>
            <Button variant="outline" size="sm" onClick={() => applyPreset(30)}>30d</Button>
            <Button variant="outline" size="sm" onClick={() => applyPreset(90)}>90d</Button>
            <Button variant="ghost" size="sm" onClick={() => applyPreset(null)}>All</Button>
          </div>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <Tabs defaultValue="aac">
          <TabsList>
            <TabsTrigger value="aac">AAC Sessions</TabsTrigger>
            <TabsTrigger value="chat">Chat Sessions</TabsTrigger>
          </TabsList>
          <TabsContent value="aac" className="mt-4">
            <SessionTypePanel
              source="aac"
              points={aacPoints}
              kpis={data?.kpis?.aac ?? emptyKpi}
              categoryBreakdown={data?.categoryBreakdown?.aac ?? {}}
              groupOptions={["student", "institute"]}
              defaultGroup="student"
              accent="#2563eb"
              emptyLabel="No AAC sessions in range."
              showGhost
            />
          </TabsContent>
          <TabsContent value="chat" className="mt-4">
            <SessionTypePanel
              source="chat"
              points={chatPoints}
              kpis={data?.kpis?.chat ?? emptyKpi}
              categoryBreakdown={data?.categoryBreakdown?.chat ?? {}}
              groupOptions={["user", "institute"]}
              defaultGroup="user"
              accent="#16a34a"
              emptyLabel="No chat sessions in range."
              showGhost={false}
            />
          </TabsContent>
        </Tabs>
      )}
    </div>
  );
}
