/**
 * fetch-sidecar-runtime.mjs — Download the 32-bit Node runtime used to run the
 * gaze sidecar against a 32-bit eye-tracker DLL.
 *
 * The x64 sidecar runs under the app's own Electron binary (ELECTRON_RUN_AS_NODE),
 * so we only need to ship a single ia32 Node. nodejs.org serves the bare exe at
 * /dist/<ver>/win-x86/node.exe, so no unzip step is required.
 *
 * Idempotent: skips the download if the file already exists.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

// Node 20 LTS matches Electron 33's bundled Node, keeping the two sidecar
// runtimes on the same major. Bump together with Electron.
const NODE_VERSION = process.env.SIDECAR_NODE_VERSION || "v20.18.1";

const target = path.join(root, "electron", "sidecar", "runtime", "win32-ia32", "node.exe");
const url = `https://nodejs.org/dist/${NODE_VERSION}/win-x86/node.exe`;

async function main() {
  if (fs.existsSync(target) && fs.statSync(target).size > 1_000_000) {
    console.log(`[sidecar-runtime] already present: ${target}`);
    return;
  }
  fs.mkdirSync(path.dirname(target), { recursive: true });

  console.log(`[sidecar-runtime] downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Download failed (${res.status} ${res.statusText}) for ${url}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(target, buf);
  console.log(`[sidecar-runtime] wrote ${target} (${(buf.length / 1e6).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error("[sidecar-runtime] ERROR:", e.message);
  process.exit(1);
});
