/**
 * gaze-sidecar-supervisor.test.ts — Lifecycle of the Electron gaze sidecar.
 *
 * The supervisor spawns a real child process, so these tests stand in a trivial
 * Node script for the sidecar and a synthetic PE stub for the vendor DLL (the
 * supervisor only reads the header's machine field to pick a runtime).
 */

import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { GazeSidecarSupervisor } from "../../electron/hardware/gaze-sidecar-supervisor.js";

/** Minimal PE file whose header claims the given machine architecture. */
function writeFakeDll(filePath: string, machine: number): void {
  const buf = Buffer.alloc(0x100);
  buf.write("MZ", 0, "ascii");
  buf.writeUInt32LE(0x80, 0x3c); // e_lfanew -> PE header offset
  buf.write("PE\0\0", 0x80, "ascii");
  buf.writeUInt16LE(machine, 0x84);
  fs.writeFileSync(filePath, buf);
}

const MACHINE_X64 = 0x8664;

/** Poll until `predicate` holds, or throw once `timeoutMs` elapses. */
async function waitFor(predicate: () => boolean, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("waitFor timed out");
}

describe("GazeSidecarSupervisor", () => {
  let dir: string;
  let supervisor: GazeSidecarSupervisor;

  /** Build a supervisor whose "sidecar" is `scriptBody`. */
  function makeSupervisor(scriptBody: string): GazeSidecarSupervisor {
    const script = path.join(dir, "fake-sidecar.cjs");
    fs.writeFileSync(script, scriptBody);
    return new GazeSidecarSupervisor({
      userDataDir: dir,
      sidecarScript: script,
      sidecarNodeModules: path.join(dir, "node_modules"),
      ia32Runtime: path.join(dir, "node32.exe"),
      port: 49312,
    });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gaze-sidecar-test-"));
    writeFakeDll(path.join(dir, "fake.dll"), MACHINE_X64);
  });

  afterEach(() => {
    supervisor?.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reports a deliberate stop as inert, not as a crash", async () => {
    // A sidecar that stays alive until it is killed.
    supervisor = makeSupervisor("setInterval(() => {}, 1000);");
    supervisor.setDll("tobii", path.join(dir, "fake.dll"));
    await waitFor(() => supervisor.getStatus().running);

    supervisor.stop();

    // The child's "exit" event fires asynchronously, after stop() has returned.
    // It must not be mistaken for a crash — this is the account-switch case that
    // surfaced "Sidecar exited (code=null)" to the student.
    await new Promise((r) => setTimeout(r, 500));

    const status = supervisor.getStatus();
    expect(status.running).toBe(false);
    expect(status.device).toBeNull();
    expect(status.sidecarCode).toBeNull();
    expect(status.sidecarMessage).toBeNull();
    expect(status.needsDll).toBe(false);
  });

  it("does not restart the sidecar after a deliberate stop", async () => {
    // Each run appends a line, so the file length counts spawns.
    const marker = path.join(dir, "spawns.log");
    supervisor = makeSupervisor(
      `require("fs").appendFileSync(${JSON.stringify(marker)}, "x");\n` +
      `setInterval(() => {}, 1000);`,
    );
    supervisor.setDll("tobii", path.join(dir, "fake.dll"));
    await waitFor(() => fs.existsSync(marker));

    supervisor.stop();
    // Longer than RESTART_BASE_MS (2s), so a scheduled restart would have fired.
    await new Promise((r) => setTimeout(r, 2600));

    expect(fs.readFileSync(marker, "utf8")).toBe("x");
    expect(supervisor.getStatus().running).toBe(false);
  });

  it("captures the port the sidecar reports over IPC and clears it on stop", async () => {
    // A sidecar that binds an OS-assigned port and reports it back, as the real
    // one does. The supervisor should surface that port in its status.
    supervisor = makeSupervisor(
      `const net = require("net");\n` +
      `const srv = net.createServer();\n` +
      `srv.listen(0, "127.0.0.1", () => {\n` +
      `  process.send({ type: "gaze-sidecar-listening", port: srv.address().port });\n` +
      `});\n` +
      `setInterval(() => {}, 1000);`,
    );
    supervisor.setDll("tobii", path.join(dir, "fake.dll"));

    await waitFor(() => supervisor.getStatus().port != null);
    const port = supervisor.getStatus().port;
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);

    supervisor.stop();
    expect(supervisor.getStatus().port).toBeNull();
  });

  it("reports an unexpected exit and schedules a restart", async () => {
    supervisor = makeSupervisor("process.exit(3);");
    supervisor.setDll("tobii", path.join(dir, "fake.dll"));

    await waitFor(() => supervisor.getStatus().sidecarCode === "exited");

    const status = supervisor.getStatus();
    expect(status.sidecarMessage).toContain("unexpectedly");
    expect(status.sidecarMessage).toContain("3");
    expect(status.device).toBe("tobii");
  });
});
