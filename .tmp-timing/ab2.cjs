const { spawn } = require('child_process');
function run(label, args, port) {
  return new Promise((res) => {
    const t = Date.now();
    const c = spawn(process.execPath, args, { env: { ...process.env, NODE_ENV: 'development', PORT: String(port) } });
    const h = (d) => {
      const s = String(d);
      if (s.includes('Email service')) console.log('>>> ' + label + ': first module log at ' + (Date.now() - t) + 'ms');
      if (s.includes('serving on port')) { console.log('>>> ' + label + ': LISTENING at ' + (Date.now() - t) + 'ms'); setTimeout(() => { c.kill('SIGKILL'); res(); }, 300); }
    };
    c.stdout.on('data', h); c.stderr.on('data', h);
    setTimeout(() => { console.log('>>> ' + label + ': TIMEOUT'); c.kill('SIGKILL'); res(); }, 200000);
  });
}
(async () => {
  await run('maps   ', ['--enable-source-maps', '--import', 'dotenv/config', '.dev/index.js'], 5099);
  await run('no-maps', ['--import', 'dotenv/config', '.dev/index.js'], 5099);
  await run('maps2  ', ['--enable-source-maps', '--import', 'dotenv/config', '.dev/index.js'], 5099);
})();
