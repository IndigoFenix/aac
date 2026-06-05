/**
 * Migrate stored board buttons (`boards.ir_data`) to the glyph-first model:
 *
 *  1. VISUAL → glyph. For any button that has no `glyph` yet, build one from its
 *     legacy fields and clear them:
 *       - symbolPath `/api/custom-symbols/<id>/image`  →  glyph `symbol:<id>`
 *       - imageKey (AI-generated)                      →  glyph `generate:<key>`
 *                                                          + glyphFallback = its
 *                                                          emoji iconRef (or 💬)
 *       - single emoji / char iconRef                  →  glyph = that emoji
 *       - FontAwesome / nav-only / no visual           →  left untouched
 *  2. COLOR → token. Bake `resolveButtonColorToken` into `button.color`
 *     (normalize a known legacy hex → its named token; fill the auto token where
 *     empty). `rebusKey` is left in place (Grid3 export metadata).
 *
 * Idempotent: a button that already has a `glyph` is left as-is, and a color
 * that's already a token resolves to itself.
 *
 * Targets the TEST/dev database via `DATABASE_URL` (the one localhost + Render
 * use) — NOT prod. Dry-run by default (prints a summary + samples, then
 * ROLLBACKs); pass --apply to COMMIT.
 *
 * Usage:
 *   npx tsx scripts/migrate-board-ir.ts            # dry run
 *   npx tsx scripts/migrate-board-ir.ts --apply    # commit
 */
import "dotenv/config";
import pg from "pg";
import { resolveButtonColorToken, COLOR_MAP } from "../shared/button-color.js";

const APPLY = process.argv.includes("--apply");

// Reverse of COLOR_MAP: known pastel hex (upper-cased) → named token, PLUS the
// legacy saturated palette (old editor default + BOARD_SYSTEM_PROMPT colors)
// folded onto the same tokens so old buttons land on a real swatch / the AAC's
// pastel rendering.
const HEX_TO_TOKEN: Record<string, string> = {
  ...Object.fromEntries(Object.entries(COLOR_MAP).map(([token, hex]) => [hex.toUpperCase(), token])),
  "#3B82F6": "blue",   // old default / "needs"
  "#F59E0B": "orange", // "emotions" (amber)
  "#EAB308": "yellow", // "activities"
  "#EC4899": "pink",   // "people"
  "#6B7280": "gray",   // "objects"
  "#059669": "green",  // "yes"
  "#DC2626": "red",    // "no"
};

/** A single emoji or single character (letter/number/punctuation), not a FontAwesome class. */
function isEmojiIcon(s: unknown): s is string {
  if (typeof s !== "string" || !s) return false;
  if (s.startsWith("fa") || s.includes(" ")) return false;
  const cps = [...s];
  if (cps.length === 1) return true;
  return cps.length <= 4 && /[\u{1F000}-\u{1FFFF}]|[\u{2600}-\u{27BF}]|[\u{2190}-\u{21FF}]|[\u{2300}-\u{27BF}]/u.test(s);
}

/** Compute the color token for a button. */
function colorForButton(button: any): string | undefined {
  let color: string | undefined = button?.color;
  if (typeof color === "string" && HEX_TO_TOKEN[color.toUpperCase()]) {
    color = HEX_TO_TOKEN[color.toUpperCase()];
  }
  return resolveButtonColorToken({ color, glyph: button?.glyph, buttonType: button?.buttonType });
}

/**
 * Mutate a single button object in place. Returns a short human-readable note of
 * what changed, or null if nothing changed.
 */
function migrateButton(button: any): string | null {
  if (!button || typeof button !== "object") return null;
  const before = { color: button.color, glyph: button.glyph };
  let glyphNote = "";

  // 1. Glyph-ify (only when there's no glyph already).
  if (!button.glyph) {
    let glyph: string | undefined;
    let glyphFallback: string | undefined;

    const symbolPath: unknown = button.symbolPath;
    const customMatch = typeof symbolPath === "string"
      ? symbolPath.match(/\/api\/custom-symbols\/([^/]+)\/image/)
      : null;

    if (customMatch) {
      glyph = `symbol:${customMatch[1]}`;
    } else if (typeof button.imageKey === "string" && button.imageKey.trim()) {
      glyph = `generate:${button.imageKey.trim()}`;
      glyphFallback = isEmojiIcon(button.iconRef) ? button.iconRef : "💬";
    } else if (isEmojiIcon(button.iconRef)) {
      glyph = button.iconRef;
    }

    if (glyph) {
      button.glyph = glyph;
      if (glyphFallback) button.glyphFallback = glyphFallback;
      // The legacy single-visual fields are superseded by the glyph.
      delete button.iconRef;
      delete button.symbolPath;
      delete button.imageKey;
      glyphNote = `glyph=${glyph}${glyphFallback ? ` (fb ${glyphFallback})` : ""}`;
    }
  }

  // 2. Color token.
  const newColor = colorForButton(button);
  const colorChanged = newColor !== before.color;
  if (colorChanged) button.color = newColor;

  if (!glyphNote && !colorChanged) return null;
  const parts: string[] = [];
  if (glyphNote) parts.push(glyphNote);
  if (colorChanged) parts.push(`color ${JSON.stringify(before.color)}→${JSON.stringify(newColor)}`);
  return `"${button.label ?? ""}": ${parts.join("; ")}`;
}

interface BoardDiff { id: string; name: string; changed: number; newIrData: any; samples: string[] }

function transformBoard(id: string, name: string, irData: any): BoardDiff | null {
  if (!irData || !Array.isArray(irData.pages)) return null;
  const next = JSON.parse(JSON.stringify(irData));
  let changed = 0;
  const samples: string[] = [];
  for (const page of next.pages) {
    if (!Array.isArray(page?.buttons)) continue;
    for (const button of page.buttons) {
      const note = migrateButton(button);
      if (note) {
        if (samples.length < 4) samples.push(note);
        changed++;
      }
    }
  }
  return changed === 0 ? null : { id, name, changed, newIrData: next, samples };
}

async function main() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) { console.error("DATABASE_URL is not set (load .env or export it)."); process.exit(1); }
  console.log(`Mode: ${APPLY ? "APPLY (will COMMIT)" : "DRY RUN (will ROLLBACK)"}`);
  console.log(`Target: ${dbUrl.replace(/:\/\/[^@]*@/, "://***@")}\n`);

  const pool = new pg.Pool({
    connectionString: dbUrl.replace(/[?&]sslmode=[^&]*/g, ""),
    ssl: { rejectUnauthorized: false },
    max: 3,
  });
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const boards = (
      await client.query("select id, name, ir_data from boards where ir_data is not null order by id")
    ).rows as Array<{ id: string; name: string; ir_data: any }>;
    console.log(`Scanned ${boards.length} board(s) with irData.\n`);

    let boardsChanged = 0;
    let buttonsChanged = 0;
    for (const row of boards) {
      const diff = transformBoard(row.id, row.name, row.ir_data);
      if (!diff) continue;
      boardsChanged++;
      buttonsChanged += diff.changed;
      console.log(`  ${diff.name} (${diff.id}) — ${diff.changed} button(s):`);
      for (const s of diff.samples) console.log(`      ${s}`);
      await client.query("update boards set ir_data = $1, updated_at = now() where id = $2", [diff.newIrData, diff.id]);
    }

    console.log(`\nSummary: ${boardsChanged} board(s) changed, ${buttonsChanged} button(s) updated.`);

    if (APPLY) {
      await client.query("COMMIT");
      console.log("\n✅ COMMITTED.");
    } else {
      await client.query("ROLLBACK");
      console.log("\n↩️  DRY RUN — rolled back, nothing persisted. Re-run with --apply to commit.");
    }
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((e) => { console.error("Migration failed:", e.message); process.exit(1); });
