const { spawn } = require('child_process');
function run(label, args, port) {
  return new Promise((res) => {
    const t = Date.now();
    const c = spawn(process.execPath, args, {
      env: { ...process.env, NODE_ENV: 'development', PORT: String(port) },
    });
    let served = null;
    const h = async (d) => {
      const s = String(d);
      process.stdout.write('[' + label + '] ' + s);
      if (!served && s.includes('serving on port')) {
        served = Date.now() - t;
        const t0 = Date.now();
        let code = 'ERR';
        try { code = (await fetch('http://localhost:' + port + '/health')).status; } catch (e) { code = e.message; }
        console.log('>>> ' + label + ': LISTENING at ' + served + 'ms, /health ' + code + ' (+' + (Date.now() - t0) + 'ms)');
      }
      if (s.includes('vite dev server ready') || s.includes('vite dev server FAILED')) {
        console.log('>>> ' + label + ': VITE READY at ' + (Date.now() - t) + 'ms');
        setTimeout(() => { c.kill('SIGKILL'); res(); }, 500);
      }
    };
    c.stdout.on('data', h);
    c.stderr.on('data', h);
    setTimeout(() => { console.log('>>> ' + label + ': TIMEOUT'); c.kill('SIGKILL'); res(); }, 280000);
  });
}
(async () => {
  await run('TSX', ['node_modules/tsx/dist/cli.mjs', 'server/index.ts'], 5098);
  await run('BUNDLE', ['scripts/dev-server.mjs'], 5099);
})();
