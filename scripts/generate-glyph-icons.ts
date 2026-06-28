// scripts/generate-glyph-icons.ts
//
// Batch-generates the constructed-glyph BASE icons into
// attached_assets/aac-icons, matching the existing icon style by passing one of
// the bundled icons as a style-guide reference image.
//
// This reuses the project's existing two-step pipeline (Gemini Flash refines a
// prompt → OpenAI gpt-image-1 renders a transparent PNG) via
// server/services/symbol/symbol-generator.ts — the same path the live AAC uses
// to auto-generate symbols. It does NOT touch the DB; it writes files directly
// into the bundled icon folder so the new glyphs ship with the app.
//
// IMPORTANT: most new glyph primitives (arrows, gauges, dot-sets, polarity,
// badges) are drawn by the COMPOSITOR, not generated as bitmaps. Only the
// concrete base icons that need real artwork live here. See
// planning-docs/glyph-system-implementation-plan.md (Phase 6).
//
// Usage:
//   tsx scripts/generate-glyph-icons.ts                # generate missing icons
//   tsx scripts/generate-glyph-icons.ts --force        # regenerate all
//   tsx scripts/generate-glyph-icons.ts --dry-run      # list what would run
//   tsx scripts/generate-glyph-icons.ts --only=person,thing
//
// Requires GEMINI_API_KEY and OPENAI_API_KEY in the environment (.env).

import "dotenv/config";
import { promises as fs } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { generateSymbolImage } from "../server/services/symbol/symbol-generator";

const __dirname_local = dirname(fileURLToPath(import.meta.url));
const ICONS_ROOT = join(__dirname_local, "..", "attached_assets", "aac-icons");

// We deliberately do NOT pass a bundled icon as a global style guide: the
// image-prompt-standards prompt already pins the flat, bold-outline AAC house
// style, and a mismatched style-reference bleeds CONTENT into the result (a
// `walk` reference makes a "person" come out walking, with an arrow). Reference
// images are used only via per-spec `reference` where content MATCHES — e.g.
// the base `person` conditioning its own gendered variants.

interface GlyphIconSpec {
  /** Output key — file written as <subfolder>/<key>.png. */
  key: string;
  /** Subfolder under attached_assets/aac-icons. */
  subfolder: string;
  /** Natural-language description fed to the prompt refiner. */
  description: string;
  /** Optional style-guide override (path under aac-icons, no extension). */
  styleGuide?: string;
  /**
   * Optional reference icon (path under aac-icons, no extension) sent to the
   * IMAGE model itself (not just the prompt refiner) to condition generation on
   * it — e.g. restyle the base `person` into gendered variants. Must already
   * exist on disk when this spec runs (order specs so the reference is generated
   * first); if missing, generation falls back to text-only with a warning.
   */
  reference?: string;
}

// The concrete base icons the constructed-glyph system needs. Schematic glyphs
// (gauge/arrows/dot-set/polarity) are intentionally absent — the compositor
// draws those.
const GLYPH_ICONS: GlyphIconSpec[] = [
  // ── People bases (body-shape gender per the spec) ───────────────────────
  {
    key: "person",
    subfolder: "people",
    description:
      "a single simple generic human figure standing front-facing, neutral pose, no gender markers, no hair, minimal dot eyes — the universal 'person' symbol",
  },
  {
    key: "person-male",
    subfolder: "people",
    reference: "people/person",
    description:
      "the SAME figure as the reference image, redrawn with a straight rectangular body like the male restroom pictogram — represents a male person. Keep the identical line weight, color, and style.",
  },
  {
    key: "person-female",
    subfolder: "people",
    reference: "people/person",
    description:
      "the SAME figure as the reference image, redrawn with a triangular skirt-shaped body like the female restroom pictogram — represents a female person. Keep the identical line weight, color, and style.",
  },
  {
    // `person-plural` (not `people-plural`) so it matches the compositor's
    // `${person.imagePath}-${suffix}` gender_body convention.
    key: "person-plural",
    subfolder: "people",
    reference: "people/person",
    description:
      "TWO copies of the SAME figure as the reference image, standing side by side and slightly overlapping — represents 'them' / a group of people. Keep the identical line weight, color, and style.",
  },

  // ── Object / abstract bases ─────────────────────────────────────────────
  {
    key: "block",
    subfolder: "things",
    description:
      "a single plain rounded cube or box seen at a slight angle, featureless — the generic 'thing' / object placeholder",
  },
  {
    key: "cause",
    subfolder: "indicators",
    description:
      "a bold curved arrow looping backward to point at a small solid dot at its origin — a 'because' / 'reason' / cause symbol showing tracing back to a source",
  },
  {
    key: "map-pin",
    subfolder: "places",
    description:
      "a folded paper map with a single teardrop location pin standing on it — the generic 'place' / 'where' symbol",
  },
  {
    key: "clock",
    subfolder: "time",
    description:
      "a simple round analog clock face seen from the front with two hands, no numbers — the generic 'time' / 'when' symbol",
  },
];

const RATE_LIMIT_MS = 4000; // match auto-symbol-service's inter-generation delay

async function loadStyleGuideBase64(path: string): Promise<string | undefined> {
  try {
    const buf = await fs.readFile(join(ICONS_ROOT, `${path}.png`));
    return buf.toString("base64");
  } catch (err) {
    console.warn(`  ⚠ style guide "${path}.png" not found — generating without a reference`);
    return undefined;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");
  const onlyArg = args.find((a) => a.startsWith("--only="));
  const only = onlyArg
    ? new Set(onlyArg.slice("--only=".length).split(",").map((s) => s.trim()))
    : null;

  if (!dryRun) {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not set");
    if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not set");
  }

  const specs = GLYPH_ICONS.filter((s) => !only || only.has(s.key));
  console.log(`Glyph icon generation — ${specs.length} candidate(s)${dryRun ? " (dry run)" : ""}\n`);

  // Cache style-guide images so we read each reference only once.
  const styleCache = new Map<string, string | undefined>();
  let generated = 0;
  let skipped = 0;

  for (const spec of specs) {
    const outDir = join(ICONS_ROOT, spec.subfolder);
    const outPath = join(outDir, `${spec.key}.png`);
    const rel = `${spec.subfolder}/${spec.key}.png`;

    if (!force && (await fileExists(outPath))) {
      console.log(`• skip   ${rel} (exists)`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`• would generate ${rel}\n          ${spec.description}`);
      continue;
    }

    let styleGuideBase64: string | undefined;
    if (spec.styleGuide) {
      if (!styleCache.has(spec.styleGuide)) {
        styleCache.set(spec.styleGuide, await loadStyleGuideBase64(spec.styleGuide));
      }
      styleGuideBase64 = styleCache.get(spec.styleGuide);
    }

    // Reference image sent to the IMAGE model itself (e.g. base person → gendered
    // variant). Must exist on disk; falls back to text-only if not.
    let referenceImages: Buffer[] | undefined;
    if (spec.reference) {
      const refPath = join(ICONS_ROOT, `${spec.reference}.png`);
      if (await fileExists(refPath)) {
        referenceImages = [await fs.readFile(refPath)];
      } else {
        console.warn(`  ⚠ reference "${spec.reference}.png" not found — generating without it`);
      }
    }

    try {
      // Pace requests to stay within image-generation rate limits.
      if (generated > 0) await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));

      console.log(`• gen    ${rel}${referenceImages ? ` (ref: ${spec.reference})` : ""} …`);
      const result = await generateSymbolImage(spec.description, { styleGuideBase64, referenceImages });
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(outPath, result.imageBuffer);
      generated++;
      console.log(`  ✓ wrote ${rel}`);
      console.log(`    prompt: ${result.refinedPrompt}`);
    } catch (err: any) {
      console.error(`  ✗ failed ${rel}: ${err?.message || err}`);
    }
  }

  console.log(`\nDone. generated=${generated} skipped=${skipped}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
