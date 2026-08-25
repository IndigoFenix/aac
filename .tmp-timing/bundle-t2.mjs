import { build } from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const LOADERS = { '.ts': 'ts', '.tsx': 'tsx', '.mts': 'ts', '.js': 'js', '.mjs': 'js', '.jsx': 'jsx' };
await build({
  entryPoints: ['.tmp-timing/t2.ts'], outfile: '.tmp-timing/out/t2b.mjs',
  bundle: true, platform: 'node', format: 'esm', target: 'node22',
  packages: 'external', sourcemap: true, sourcesContent: false, logLevel: 'warning',
  plugins: [{ name: 'p', setup(b) { b.onLoad({ filter: /\.(tsx?|mts|jsx?|mjs)$/ }, async (a) => {
    let c = await fs.promises.readFile(a.path, 'utf8');
    if (c.includes('import.meta.')) c = c.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(a.path).href)).replaceAll('import.meta.dirname', JSON.stringify(path.dirname(a.path))).replaceAll('import.meta.filename', JSON.stringify(a.path));
    return { contents: c, loader: LOADERS[path.extname(a.path)] ?? 'ts' }; } ); } }],
});
console.log('bundled');
