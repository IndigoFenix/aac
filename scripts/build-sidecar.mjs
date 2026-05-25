/**
 * build-sidecar.mjs — Assemble the gaze sidecar bundle for packaging.
 *
 * Produces dist-sidecar/gaze-sidecar/ containing everything the sidecar needs at
 * runtime, which electron-builder ships via extraResources to resources/gaze-sidecar:
 *
 *   gaze-sidecar/
 *     gaze-sidecar.cjs
 *     node_modules/koffi   (Windows prebuilds only)
 *     node_modules/ws
 *     runtime/win32-ia32/node.exe
 *
 * Run after `npm run electron:build`, before electron-builder.
 */

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFileSync } from "child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const stage = path.join(root, "dist-sidecar", "gaze-sidecar");
// NB: must NOT be literally "node_modules" — electron-builder strips a folder by
// that name from extraResources. We point NODE_PATH at this dir instead, which
// Node treats as a module search root all the same.
const nodeModulesOut = path.join(stage, "sidecar_modules");

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function copyDir(src, dst) { fs.cpSync(src, dst, { recursive: true }); }

function main() {
  // 1. Ensure the 32-bit runtime is present.
  execFileSync(process.execPath, [path.join(root, "scripts", "fetch-sidecar-runtime.mjs")], {
    stdio: "inherit",
  });

  // 2. Clean + recreate staging.
  rmrf(stage);
  fs.mkdirSync(nodeModulesOut, { recursive: true });

  // 3. The sidecar script.
  fs.copyFileSync(
    path.join(root, "electron", "sidecar", "gaze-sidecar.cjs"),
    path.join(stage, "gaze-sidecar.cjs"),
  );

  // 4. koffi (Windows prebuilds only — drop other platforms to save space).
  const koffiSrc = path.join(root, "node_modules", "koffi");
  const koffiDst = path.join(nodeModulesOut, "koffi");
  copyDir(koffiSrc, koffiDst);
  const prebuildDir = path.join(koffiDst, "build", "koffi");
  if (fs.existsSync(prebuildDir)) {
    for (const entry of fs.readdirSync(prebuildDir)) {
      if (!entry.startsWith("win32_")) {
        rmrf(path.join(prebuildDir, entry));
      }
    }
  }

  // 5. ws (no runtime dependencies).
  copyDir(path.join(root, "node_modules", "ws"), path.join(nodeModulesOut, "ws"));

  // 6. The 32-bit Node runtime.
  const runtimeSrc = path.join(root, "electron", "sidecar", "runtime", "win32-ia32", "node.exe");
  const runtimeDst = path.join(stage, "runtime", "win32-ia32", "node.exe");
  fs.mkdirSync(path.dirname(runtimeDst), { recursive: true });
  fs.copyFileSync(runtimeSrc, runtimeDst);

  console.log(`[build-sidecar] assembled ${stage}`);
}

main();
