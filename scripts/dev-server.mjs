// scripts/dev-server.mjs
// Fast dev boot for the API server.
//
// Why this exists: `tsx server/index.ts` loads the server's ~1800-module
// graph one file at a time through a JS loader hook. On this repo that costs
// ~40s before the first request is served, and the split is roughly
// 20s in the loader's `resolve` (4100+ resolutions), 9s in transform and
// ~9s in evaluation. Bundling our own source with esbuild first collapses
// all of that into a single module: the same graph imports in ~2s.
//
// node_modules stay external (`packages: 'external'`), so only server/ and
// shared/ are bundled and node resolves dependencies natively.
//
// Bundling moves every module into one file, which would otherwise change
// what `import.meta.dirname` / `.url` / `.filename` mean — several modules
// derive log-file and template paths from them. The plugin below substitutes
// each module's ORIGINAL path at build time so those stay correct.

import { spawn } from 'node:child_process';
import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, '.dev');
const outFile = path.join(outDir, 'index.js');

const LOADERS = { '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.js': 'js', '.mjs': 'js', '.jsx': 'jsx' };

/**
 * Rewrite `import.meta.{url,dirname,filename}` to literals describing the
 * module's real location on disk, before it is folded into the bundle.
 */
const preserveImportMeta = {
  name: 'preserve-import-meta',
  setup(pluginBuild) {
    pluginBuild.onLoad({ filter: /\.(tsx?|mts|jsx?|mjs)$/ }, async (args) => {
      const loader = LOADERS[path.extname(args.path)] ?? 'ts';
      let contents = await fs.promises.readFile(args.path, 'utf8');
      if (contents.includes('import.meta.')) {
        contents = contents
          .replaceAll('import.meta.url', JSON.stringify(pathToFileURL(args.path).href))
          .replaceAll('import.meta.dirname', JSON.stringify(path.dirname(args.path)))
          .replaceAll('import.meta.filename', JSON.stringify(args.path));
      }
      return { contents, loader };
    });
  },
};

const started = Date.now();
await build({
  entryPoints: [path.join(root, 'server', 'index.ts')],
  outdir: outDir,
  bundle: true,
  // Keep dynamic imports lazy. Without splitting, esbuild folds an
  // `await import('./vite')` into the entry chunk and hoists vite's own
  // imports to the top, so node loads the whole Vite toolchain (~16s)
  // before the first line of our code runs. Split chunks preserve the
  // deferral the source intended.
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  sourcemap: true,
  sourcesContent: false,
  logLevel: 'warning',
  plugins: [preserveImportMeta],
});
console.log(`[dev] server bundled in ${Date.now() - started}ms`);

// `--import dotenv/config` rather than relying on server/index.ts's own
// `import 'dotenv/config'`: code splitting puts shared chunks ahead of the
// entry's own imports, so a module that reads process.env at module scope
// (server/db.ts does) would otherwise evaluate before .env is loaded.
const child = spawn(
  process.execPath,
  ['--enable-source-maps', '--import', 'dotenv/config', outFile],
  { stdio: 'inherit', cwd: root, env: { ...process.env, NODE_ENV: 'development' } },
);
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => child.kill(sig));
}
child.on('exit', (code, signal) => {
  process.exit(signal ? 1 : code ?? 0);
});
