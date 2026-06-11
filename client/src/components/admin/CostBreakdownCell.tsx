import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/** Per-function-type cost split (chat_sessions.cost_breakdown).
 *  Keys are charge categories ("chat", "observer", "tts", "tool:<name>", ...),
 *  values are USD credits. Only populated for charges recorded after the
 *  column was introduced, so values may sum to less than creditsUsed. */
export type SessionCostBreakdown = Record<string, number>;

/** Session cost with a click-to-open per-function-type breakdown.
 *  Admin-only views, so strings stay in English (no i18n) — same convention
 *  as the rest of the admin dashboard. Sessions recorded before cost_breakdown
 *  was introduced have no (or partial) breakdown; the remainder is shown as a
 *  separate "untracked" line so the rows always reconcile with the total. */
export function CostBreakdownCell({
  credits,
  breakdown,
  digits = 2,
}: {
  credits: number;
  breakdown?: SessionCostBreakdown | null;
  /** Decimal places for the collapsed trigger value (popover rows always use 4). */
  digits?: number;
}) {
  const entries = useMemo(
    () =>
      Object.entries(breakdown ?? {})
        .filter(([, v]) => typeof v === "number" && v > 0)
        .sort((a, b) => b[1] - a[1]),
    [breakdown]
  );

  if (entries.length === 0) {
    return <span className="tabular-nums">${credits.toFixed(digits)}</span>;
  }

  const tracked = entries.reduce((sum, [, v]) => sum + v, 0);
  const untracked = credits - tracked;
  const maxAmount = entries[0][1];

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2 font-normal tabular-nums underline decoration-dotted underline-offset-4"
          title="Show cost breakdown"
        >
          ${credits.toFixed(digits)}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <p className="text-sm font-semibold mb-2">Cost breakdown</p>
        <div className="space-y-1.5">
          {entries.map(([category, amount]) => (
            <div key={category}>
              <div className="flex items-baseline justify-between gap-4 text-xs">
                <span className="font-mono truncate">{category}</span>
                <span className="tabular-nums shrink-0">
                  ${amount.toFixed(4)}
                  <span className="text-muted-foreground ms-1">
                    {Math.round((amount / tracked) * 100)}%
                  </span>
                </span>
              </div>
              <div className="h-1 bg-muted rounded overflow-hidden mt-0.5">
                <div
                  className="h-full bg-primary rounded"
                  style={{ width: `${Math.max(2, (amount / maxAmount) * 100)}%` }}
                />
              </div>
            </div>
          ))}
          {untracked > 0.0001 && (
            <div className="flex items-baseline justify-between gap-4 text-xs text-muted-foreground pt-1.5 border-t mt-2">
              <span>untracked (pre-breakdown)</span>
              <span className="tabular-nums">${untracked.toFixed(4)}</span>
            </div>
          )}
          <div className="flex items-baseline justify-between gap-4 text-xs font-semibold pt-1.5 border-t mt-2">
            <span>Total</span>
            <span className="tabular-nums">${credits.toFixed(4)}</span>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
