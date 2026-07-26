// client-aac/src/lib/debug-log.ts
//
// An in-app log buffer for debugging the packaged clients — especially the
// iPad build, where there is no attached Mac/Safari inspector and no terminal
// to read. `install()` hooks console + global error events into a bounded ring
// buffer; DebugConsole.tsx renders it on-device behind a hidden gesture, with
// copy-to-clipboard so a tester can send logs back.
//
// Kept dependency-free and side-effect-light so it is safe to install before
// the app renders (main.tsx), capturing the earliest boot errors.

export type LogLevel = "log" | "info" | "warn" | "error" | "debug";

export interface LogEntry {
  id: number;
  /** Wall-clock ms (Date.now) at capture. */
  time: number;
  level: LogLevel;
  text: string;
}

/** Keep the last N entries. Old entries drop off the front. */
const MAX_ENTRIES = 600;
/** Truncate any single entry so one giant object can't blow up memory. */
const MAX_TEXT = 4000;

let buffer: LogEntry[] = [];
let seq = 0;
const listeners = new Set<() => void>();
let installed = false;

function notify(): void {
  for (const fn of listeners) {
    try { fn(); } catch { /* a broken listener must not break logging */ }
  }
}

/** Subscribe to buffer changes (for React's useSyncExternalStore). */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Current entries (stable reference until the next push/clear). */
export function getEntries(): LogEntry[] {
  return buffer;
}

export function clearLog(): void {
  buffer = [];
  notify();
}

/** Render one console argument to a string, tolerating circular refs / Errors. */
function stringifyArg(arg: unknown): string {
  if (typeof arg === "string") return arg;
  if (arg instanceof Error) return `${arg.name}: ${arg.message}${arg.stack ? `\n${arg.stack}` : ""}`;
  if (arg === undefined) return "undefined";
  if (arg === null) return "null";
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      arg,
      (_k, v) => {
        if (typeof v === "object" && v !== null) {
          if (seen.has(v)) return "[Circular]";
          seen.add(v);
        }
        if (typeof v === "bigint") return v.toString();
        return v;
      },
      2,
    ) ?? String(arg);
  } catch {
    return String(arg);
  }
}

/** Append an entry. Used by the console hooks and by callers that want to log
 *  without also writing to the real console (e.g. API-layer diagnostics). */
export function pushLog(level: LogLevel, parts: unknown[]): void {
  let text = parts.map(stringifyArg).join(" ");
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}… [truncated]`;
  // New array (not push) so useSyncExternalStore sees a changed reference.
  buffer = buffer.concat({ id: ++seq, time: Date.now(), level, text });
  if (buffer.length > MAX_ENTRIES) buffer = buffer.slice(buffer.length - MAX_ENTRIES);
  notify();
}

/**
 * Hook console methods and global error events into the buffer. Idempotent.
 * The original console methods are still called, so nothing is lost for anyone
 * who does have a real console attached.
 */
export function install(): void {
  if (installed || typeof window === "undefined") return;
  installed = true;

  const levels: LogLevel[] = ["log", "info", "warn", "error", "debug"];
  for (const level of levels) {
    const original = console[level] as (...args: unknown[]) => void;
    console[level] = (...args: unknown[]) => {
      pushLog(level, args);
      try { original.apply(console, args); } catch { /* ignore */ }
    };
  }

  window.addEventListener("error", (e: ErrorEvent) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : "";
    pushLog("error", [`[window.onerror] ${e.message}${where}`, e.error?.stack ?? ""]);
  });

  window.addEventListener("unhandledrejection", (e: PromiseRejectionEvent) => {
    const reason = e.reason;
    pushLog("error", ["[unhandledrejection]", reason instanceof Error ? reason : stringifyArg(reason)]);
  });
}

/** A short context header included when logs are copied/exported. */
export function contextHeader(): string {
  const w = typeof window !== "undefined" ? window : undefined;
  const version = (globalThis as { __APP_VERSION__?: string }).__APP_VERSION__;
  return [
    `Aivota AAC debug log`,
    `time: ${new Date().toISOString()}`,
    version ? `appVersion(build): ${version}` : null,
    w ? `origin: ${w.location.origin}` : null,
    w ? `href: ${w.location.href}` : null,
    typeof navigator !== "undefined" ? `ua: ${navigator.userAgent}` : null,
  ].filter(Boolean).join("\n");
}

/** The whole buffer as copyable text, prefixed with the context header. */
export function exportText(): string {
  const body = buffer
    .map((e) => `${new Date(e.time).toISOString().slice(11, 23)} ${e.level.toUpperCase().padEnd(5)} ${e.text}`)
    .join("\n");
  return `${contextHeader()}\n${"-".repeat(40)}\n${body}\n`;
}
