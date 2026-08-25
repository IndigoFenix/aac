import fs from 'node:fs';
const loads = [];
const resolves = [];
let timer = null;
function agg(arr) {
  const total = arr.reduce((s, x) => s + x[0], 0);
  return { n: arr.length, total };
}
function dump() {
  const L = agg(loads), R = agg(resolves);
  const top = [...resolves].sort((a, b) => b[0] - a[0]).slice(0, 40);
  fs.writeFileSync('.tmp-timing/load-report.txt',
    `loads=${L.n} loadMs=${L.total.toFixed(0)}  resolves=${R.n} resolveMs=${R.total.toFixed(0)}\n` +
    '--- slowest resolves ---\n' +
    top.map(([ms, u]) => `${ms.toFixed(1)}\t${u}`).join('\n'));
}
function tick() {
  if (timer) clearTimeout(timer);
  timer = setTimeout(dump, 1500);
  timer.unref?.();
}
export async function resolve(spec, context, nextResolve) {
  const t = process.hrtime.bigint();
  try {
    return await nextResolve(spec, context);
  } finally {
    resolves.push([Number(process.hrtime.bigint() - t) / 1e6, spec + ' <- ' + (context.parentURL || '')]);
    tick();
  }
}
export async function load(url, context, nextLoad) {
  const t = process.hrtime.bigint();
  const r = await nextLoad(url, context);
  loads.push([Number(process.hrtime.bigint() - t) / 1e6, url]);
  tick();
  return r;
}
