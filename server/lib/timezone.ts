// server/lib/timezone.ts
// TZ-aware formatting helpers. Event times are stored/transmitted as UTC;
// these helpers format or compute day-boundaries in an IANA zone for AI prompts
// and "today/upcoming" windows.

/** Format a Date in the given IANA timezone as "YYYY-MM-DD HH:mm (TZ)". */
export function formatLocalDateTime(d: Date, timezone?: string): string {
  if (!timezone) return d.toISOString();
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hour12: false,
    }).formatToParts(d);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")} (${timezone})`;
  } catch {
    return d.toISOString();
  }
}

/** Return the UTC instant that corresponds to midnight (start-of-day) in the given IANA zone. */
export function startOfDayInTimezone(timezone: string, ref: Date = new Date()): Date {
  // Compute what year/month/day "now" is in the target zone.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(ref);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const day = parts.find((p) => p.type === "day")!.value;
  // That calendar day at 00:00:00 in the zone. To get the UTC instant, we first
  // form the same wall-clock as UTC, then subtract the zone's offset at that moment.
  const utcGuess = new Date(`${y}-${m}-${day}T00:00:00Z`);
  const offsetMinutes = timezoneOffsetMinutes(timezone, utcGuess);
  return new Date(utcGuess.getTime() - offsetMinutes * 60 * 1000);
}

/** Offset in minutes for the given zone at the given instant (positive for zones east of UTC). */
export function timezoneOffsetMinutes(timezone: string, at: Date): number {
  // Trick: format the instant in the zone, reparse as if it were UTC, and diff.
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
  const parts = dtf.formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  const asUtcIfLocal = Date.UTC(
    Number(get("year")),
    Number(get("month")) - 1,
    Number(get("day")) === 24 ? 0 : Number(get("day")), // 24h edge, rare
    Number(get("hour")) === 24 ? 0 : Number(get("hour")),
    Number(get("minute")),
    Number(get("second")),
  );
  return Math.round((asUtcIfLocal - at.getTime()) / 60000);
}

/** Human-readable "today" label in the zone, e.g. "Thursday, April 23, 2026". */
export function describeTodayInTimezone(timezone: string, ref: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "long", year: "numeric", month: "long", day: "numeric",
    }).format(ref);
  } catch {
    return ref.toISOString().slice(0, 10);
  }
}
