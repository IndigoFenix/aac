/**
 * Kill any process listening on a TCP port. Cross-platform.
 *
 * Usage: `node src/scripts/kill-port.mjs <port>`
 *
 * Why this exists: on Windows, pressing Ctrl+C in `npm run dev` often kills
 * the npm wrapper but not the Vite process beneath it, so the dev port stays
 * occupied. Vite would then silently jump to the next free port — combined
 * with `strictPort: true` in vite.config.ts, that becomes a hard error
 * instead. This predev script frees the port before each run.
 *
 * Exits 0 whether or not it found something to kill — the goal is "port is
 * free now," not "I successfully killed something." Errors are logged but
 * non-fatal so a clean machine doesn't fail the dev start.
 */

import { execSync } from 'node:child_process';
import { platform } from 'node:os';

const port = Number(process.argv[2]);
if (!Number.isInteger(port) || port <= 0) {
	console.error(`Usage: kill-port.mjs <port>   (got: ${process.argv[2]})`);
	process.exit(2);
}

function run(cmd) {
	try {
		return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
	} catch (err) {
		// Many of the lookup commands below exit non-zero when no match is
		// found. That isn't an error from our perspective.
		return err.stdout?.toString() ?? '';
	}
}

const isWindows = platform() === 'win32';
let killed = 0;

if (isWindows) {
	// `netstat -ano` columns: Proto, LocalAddr, ForeignAddr, State, PID.
	// We grep for `:<port>` in the local address and the LISTENING state to
	// avoid grabbing outbound connections to the same port number.
	//
	// Don't pass `-p TCP` — on Windows that filter silently drops IPv6-only
	// listeners (TCPv6), and Vite binds to `[::1]` by default. Without the
	// filter the same `^TCP` regex matches both v4 and v6 lines.
	const out = run(`netstat -ano`);
	const pids = new Set();
	for (const line of out.split(/\r?\n/)) {
		// Match lines whose local address ends in `:<port>` and that are LISTENING.
		const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/);
		if (m && Number(m[1]) === port) pids.add(m[2]);
	}
	for (const pid of pids) {
		run(`taskkill /F /PID ${pid}`);
		killed++;
	}
} else {
	// `lsof -t -i:<port> -sTCP:LISTEN` prints one PID per line, nothing else.
	const out = run(`lsof -t -i:${port} -sTCP:LISTEN`);
	const pids = out.split(/\s+/).filter(s => /^\d+$/.test(s));
	for (const pid of pids) {
		run(`kill -9 ${pid}`);
		killed++;
	}
}

if (killed > 0) {
	console.log(`kill-port: freed port ${port} (${killed} process${killed === 1 ? '' : 'es'} killed)`);
}
