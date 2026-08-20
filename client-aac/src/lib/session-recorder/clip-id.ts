// client-aac/src/lib/session-recorder/clip-id.ts
//
// A clip id names three files on disk, so its shape is a contract with the
// Electron store (electron/hardware/recording-store.ts validates it against the
// same pattern before opening anything, and its folder sweep parses the
// timestamp back out of it to order clips without reading every manifest).
//
//   20260820-141233-a4f1
//   └ local wall clock ┘ └ collision guard
//
// Local time, not UTC, on purpose: these files are found and sorted by a human
// in a file manager, who is looking for "the session this afternoon".

/** The shape the Electron store accepts. Keep in step with CLIP_ID_PATTERN there. */
export const CLIP_ID_PATTERN = /^[0-9]{8}-[0-9]{6}-[a-z0-9]{4}$/;

function pad(n: number, width: number): string {
  return String(n).padStart(width, "0");
}

/**
 * Mint a clip id for a moment in time.
 *
 * `suffix` is injected rather than generated so the function stays pure and
 * testable; callers pass a short random string. Two clips minted in the same
 * second would otherwise share a filename — impossible under the length cap,
 * but a rotation racing a manual restart is exactly the kind of thing that
 * turns out to be possible later.
 */
export function makeClipId(at: Date, suffix: string): string {
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1, 2)}${pad(at.getDate(), 2)}` +
    `-${pad(at.getHours(), 2)}${pad(at.getMinutes(), 2)}${pad(at.getSeconds(), 2)}`;
  const clean = suffix.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 4).padEnd(4, "0");
  return `${stamp}-${clean}`;
}

/** A random 4-character suffix for {@link makeClipId}. */
export function randomClipSuffix(): string {
  return Math.random().toString(36).slice(2, 6).padEnd(4, "0");
}

/** Parse the wall clock back out of a clip id, or null if it isn't one. */
export function clipIdTime(id: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/.exec(id);
  if (!m) return null;
  const t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(t) ? t : null;
}
