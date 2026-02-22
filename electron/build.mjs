import { build } from "esbuild";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");

const common = {
  bundle: true,
  platform: "node",
  target: "node20",
  sourcemap: true,
  external: ["electron"],
  logLevel: "info",
};

// Main process — ESM (Electron 28+ supports ESM main)
await build({
  ...common,
  entryPoints: [path.join(root, "electron/main.ts")],
  outfile: path.join(root, "dist-electron/main.js"),
  format: "esm",
  banner: {
    // Provide __dirname/__filename for ESM compatibility
    js: 'import { createRequire } from "module"; const require = createRequire(import.meta.url);',
  },
});

// Preload — CJS (Electron requires CJS for preload scripts)
await build({
  ...common,
  entryPoints: [path.join(root, "electron/preload.ts")],
  outfile: path.join(root, "dist-electron/preload.js"),
  format: "cjs",
});

console.log("Electron build complete.");
