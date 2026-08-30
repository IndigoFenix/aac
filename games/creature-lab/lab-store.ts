// Dev-server side of the creature lab's SAVE / LOAD, as a Vite plugin.
//
// The lab is a browser page, so "save this body" has to land somewhere a
// Node process owns. That somewhere is
// shared/world-engine/creatures/lab-blueprints.ts — a machine-generated TS
// module the species registry applies LAST, so a body saved here is the body
// the game builds, with no copy-paste step in between.
//
// Dev only: the plugin is a `configureServer` hook, so the built page (which
// has no server behind it) simply gets a failed fetch and falls back to the
// download/upload buttons.
import { promises as fs } from "fs";
import path from "path";
import type { Plugin } from "vite";

const ROUTE = "/api/lab-blueprints";

const HEADER = `// shared/world-engine/creatures/lab-blueprints.ts
//
// MACHINE-GENERATED — the creature lab writes this file. Do not hand-edit it:
// the next "save" from the lab rewrites it whole and your edit is gone. To
// change a body here, open the lab (\`npm run dev:creature-lab\`), pick the
// species, adjust it and press save.
//
// Each entry is a FULL blueprint in the interchange format keyed by its
// \`name\` = the species id it overrides. species.ts applies these LAST, so a
// body tuned in the lab beats both the curated examples (examples.ts) and the
// people blueprints (animals-people.ts).
//
// Empty is the normal state: it only fills up while a body is being tuned,
// and a finished body belongs back in its own source (an example, a people
// blueprint) so it can carry comments and review.
export const LAB_BLUEPRINTS: Array<Record<string, unknown>> = `;

type Entry = Record<string, unknown>;

/** Read the module back by evaluating just its array literal — the file is
 *  machine-written, so the literal is plain JSON and needs no TS parse. */
async function readStore(file: string): Promise<Entry[]> {
  let src: string;
  try {
    src = await fs.readFile(file, "utf8");
  } catch {
    return [];
  }
  const at = src.indexOf("= ");
  if (at < 0) return [];
  const body = src.slice(at + 2).trim().replace(/;\s*$/, "");
  try {
    return JSON.parse(body) as Entry[];
  } catch {
    return [];
  }
}

async function writeStore(file: string, entries: Entry[]): Promise<void> {
  const sorted = [...entries].sort((a, b) => String(a.name).localeCompare(String(b.name)));
  await fs.writeFile(file, `${HEADER}${JSON.stringify(sorted, null, 2)};\n`, "utf8");
}

function readBody(req: NodeJS.ReadableStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    req.on("data", (c) => {
      buf += String(c);
      // A blueprint is a few KB; anything past this is not one.
      if (buf.length > 2_000_000) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(buf));
    req.on("error", reject);
  });
}

export function labStore(repoRoot: string): Plugin {
  const file = path.resolve(repoRoot, "shared", "world-engine", "creatures", "lab-blueprints.ts");
  return {
    name: "creature-lab-store",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(ROUTE, (req, res) => {
        const send = (code: number, payload: unknown): void => {
          res.statusCode = code;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify(payload));
        };
        void (async () => {
          try {
            if (req.method === "GET") {
              send(200, { entries: await readStore(file) });
              return;
            }
            if (req.method === "POST") {
              const { name, blueprint } = JSON.parse(await readBody(req)) as {
                name?: string; blueprint?: Entry;
              };
              if (!name || !blueprint) {
                send(400, { error: "name and blueprint are required" });
                return;
              }
              const entries = await readStore(file);
              const next = { ...blueprint, name };
              const at = entries.findIndex((e) => e.name === name);
              if (at >= 0) entries[at] = next;
              else entries.push(next);
              await writeStore(file, entries);
              send(200, { ok: true, saved: name, count: entries.length });
              return;
            }
            if (req.method === "DELETE") {
              const { name } = JSON.parse(await readBody(req)) as { name?: string };
              const entries = (await readStore(file)).filter((e) => e.name !== name);
              await writeStore(file, entries);
              send(200, { ok: true, removed: name, count: entries.length });
              return;
            }
            send(405, { error: `unsupported method ${req.method}` });
          } catch (err) {
            send(500, { error: err instanceof Error ? err.message : String(err) });
          }
        })();
      });
    },
  };
}
