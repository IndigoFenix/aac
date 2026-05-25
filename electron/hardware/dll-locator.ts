/**
 * dll-locator.ts — Find a vendor eye-tracker DLL on this machine and determine
 * its CPU architecture (so the supervisor can launch a matching-bitness sidecar).
 *
 * Generic over device: each device contributes a list of candidate paths and the
 * DLL filename. A consumer install may ship only a 32-bit DLL, only 64-bit, or
 * both, so we report the architecture of whatever we find rather than assuming.
 */

import fs from "fs";
import path from "path";

export type DllArch = "ia32" | "x64" | "arm64" | "unknown";

export interface DllCandidate {
  path: string;
  arch: DllArch;
}

const PROGRAM_FILES = process.env["ProgramFiles"] || "C:\\Program Files";
const PROGRAM_FILES_X86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";

/** Per-device DLL filename + the directories to search for it. */
interface DeviceDllSpec {
  fileName: string;
  /** Directories to probe (the fileName is appended to each). */
  dirs: string[];
}

const DEVICE_DLLS: Record<string, DeviceDllSpec> = {
  tobii: {
    fileName: "tobii_stream_engine.dll",
    dirs: [
      // Tobii Dynavox (Computer Control / Communicator) — confirmed on a real IS5
      path.join(PROGRAM_FILES_X86, "Tobii Dynavox", "Computer Control"),
      path.join(PROGRAM_FILES, "Tobii Dynavox", "Computer Control"),
      path.join(PROGRAM_FILES_X86, "Tobii Dynavox"),
      path.join(PROGRAM_FILES, "Tobii Dynavox"),
      // Tobii Experience / Eye Tracking Core (consumer trackers)
      path.join(PROGRAM_FILES, "Tobii", "Tobii Experience"),
      path.join(PROGRAM_FILES_X86, "Tobii", "Tobii Experience"),
      path.join(PROGRAM_FILES, "Tobii", "Tobii EyeX"),
      path.join(PROGRAM_FILES_X86, "Tobii", "Tobii EyeX"),
      // Stream Engine SDK standalone install
      path.join(PROGRAM_FILES, "Tobii", "Tobii Stream Engine"),
      path.join(PROGRAM_FILES_X86, "Tobii", "Tobii Stream Engine"),
    ],
  },
  // Future devices register their DLL specs here (eyetech, lctech, ...).
};

/**
 * Read the PE header machine field to determine the DLL's architecture.
 * Returns "unknown" if the file can't be parsed.
 */
export function readDllArch(filePath: string): DllArch {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const header = Buffer.alloc(0x40);
    fs.readSync(fd, header, 0, 0x40, 0);
    // "MZ" DOS signature
    if (header[0] !== 0x4d || header[1] !== 0x5a) return "unknown";
    const peOffset = header.readUInt32LE(0x3c);
    const machineBuf = Buffer.alloc(2);
    fs.readSync(fd, machineBuf, 0, 2, peOffset + 4);
    const machine = machineBuf.readUInt16LE(0);
    switch (machine) {
      case 0x8664: return "x64";
      case 0x014c: return "ia32";
      case 0xaa64: return "arm64";
      default: return "unknown";
    }
  } catch {
    return "unknown";
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

/**
 * Search the known install locations for a device's DLL.
 * Also scans PATH directories as a last resort.
 * Returns all distinct candidates found, each with its architecture.
 */
export function findDeviceDlls(device: string): DllCandidate[] {
  const spec = DEVICE_DLLS[device];
  if (!spec) return [];

  const seen = new Set<string>();
  const found: DllCandidate[] = [];

  const consider = (dir: string) => {
    const full = path.join(dir, spec.fileName);
    const key = full.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    if (fs.existsSync(full)) {
      found.push({ path: full, arch: readDllArch(full) });
    }
  };

  for (const dir of spec.dirs) consider(dir);
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (dir) consider(dir);
  }

  return found;
}

/**
 * Pick the best DLL candidate for a device. We can run either bitness (x64 via
 * Electron-as-node, ia32 via a bundled Node), so we just prefer one with a known
 * architecture. Returns null if none found.
 */
export function locateDeviceDll(device: string): DllCandidate | null {
  const candidates = findDeviceDlls(device);
  if (candidates.length === 0) return null;
  const usable = candidates.find((c) => c.arch === "x64" || c.arch === "ia32");
  return usable || candidates[0];
}
