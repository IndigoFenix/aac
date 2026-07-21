/**
 * gaze-sidecar.cjs — Standalone eye-tracker bridge process.
 *
 * Runs as a SEPARATE process from the main Electron app so that loading a native
 * vendor DLL (which must match the DLL's bitness, and which can crash hard) never
 * takes down the app. The main process spawns this with a runtime whose
 * architecture matches the DLL (x64 via Electron-as-node, ia32 via a bundled
 * 32-bit Node). See electron/hardware/gaze-sidecar-supervisor.ts.
 *
 * Responsibilities:
 *   - Load the vendor DLL via koffi and stream gaze samples.
 *   - Serve those samples over a localhost WebSocket (+ GET /status) on one port.
 *     The renderer's WebSocketBridgeProvider (createTobiiProvider, etc.) connects
 *     here unchanged.
 *   - Keep retrying the device connection on failure (periodic reconnect).
 *
 * CLI:
 *   node gaze-sidecar.cjs --device tobii --dll "C:\\path\\tobii_stream_engine.dll" [--port 0]
 *
 * Port: omit --port (or pass 0) to bind an OS-assigned free port — the default,
 * and what the supervisor does. A fixed port (esp. 49152, the first ephemeral
 * port) collides with other eye-gaze software and lands in Windows' reserved
 * ranges (EADDRINUSE / EACCES). The actual bound port is sent to the parent over
 * IPC ({ type: "gaze-sidecar-listening", port }) so the renderer can discover it.
 *
 * Output format on the WebSocket (what parseTobii expects):
 *   { gazePoint: { x: 0-1, y: 0-1 }, validity: 0|1, timestamp: number }
 *
 * Logs go to stdout/stderr; the supervisor captures and writes them to a file.
 */

"use strict";

const http = require("http");
const path = require("path");
const fs = require("fs");

// koffi + ws are resolved from the sidecar's bundled node_modules (NODE_PATH is
// set by the supervisor, falling back to the normal resolution in dev).
const koffi = require("koffi");
const { WebSocketServer, WebSocket } = require("ws");

// ============================================================================
// CLI args
// ============================================================================

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) { out[key] = next; i++; }
      else { out[key] = true; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const DEVICE = String(args.device || "tobii").toLowerCase();
const DLL_PATH = args.dll ? String(args.dll) : null;
// 0 = let the OS assign a free port (avoids fixed-port collisions / reserved
// ranges). parseArgs may yield undefined -> NaN; both fall through to 0.
const PORT = Number.isInteger(parseInt(args.port, 10)) ? parseInt(args.port, 10) : 0;
const RECONNECT_MS = parseInt(args.reconnectMs, 10) || 3000;

function log(...a) {
  const line = "[" + new Date().toISOString() + "] [gaze-sidecar:" + DEVICE + "] " +
    a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  process.stdout.write(line + "\n");
}

// ============================================================================
// Device drivers — one per vendor. Each driver exposes:
//   start(dllPath, { onGaze, onStatus }) -> boolean (true if connected)
//   stop()
//   get connected
// A driver emits gaze as { gazePoint: {x,y}, validity, timestamp }.
// Add new trackers by registering another driver here.
// ============================================================================

const drivers = {};

// ── Tobii Stream Engine driver (koffi FFI) ──
// This is the binding proven against a real Tobii Dynavox IS5 device.
drivers.tobii = createTobiiDriver();

function createTobiiDriver() {
  const TOBII_ERRORS = {
    0: "NO_ERROR", 1: "INTERNAL", 2: "INSUFFICIENT_LICENSE", 3: "NOT_SUPPORTED",
    4: "NOT_AVAILABLE", 5: "CONNECTION_FAILED", 6: "TIMED_OUT", 7: "ALLOCATION_FAILED",
    8: "INVALID_PARAMETER", 9: "CALIBRATION_ALREADY_STARTED", 10: "CALIBRATION_NOT_STARTED",
    11: "ALREADY_SUBSCRIBED", 12: "NOT_SUBSCRIBED", 13: "OPERATION_FAILED",
    14: "CONFLICTING_API_INSTANCES", 15: "CALIBRATION_BUSY", 16: "CALLBACK_IN_PROGRESS",
    17: "TOO_MANY_SUBSCRIBERS", 18: "CONNECTION_FAILED_DRIVER", 19: "UNAUTHORIZED",
  };
  const errName = (c) => (TOBII_ERRORS[c] ? `${c} (TOBII_ERROR_${TOBII_ERRORS[c]})` : `${c} (unknown)`);

  // koffi registers named types globally per process — define once.
  let types = null;
  function defineTypes() {
    if (types) return types;
    types = {
      api: koffi.opaque("tobii_api_t"),
      device: koffi.opaque("tobii_device_t"),
      gazePoint: koffi.struct("tobii_gaze_point_t", {
        timestamp_us: "int64",
        validity: "int",
        position_xy: koffi.array("float", 2),
      }),
      urlReceiver: koffi.proto("void tobii_url_receiver(const char* url, void* user_data)"),
      gazeCallback: koffi.proto("void tobii_gaze_cb(const tobii_gaze_point_t* gaze_point, void* user_data)"),
    };
    return types;
  }

  let lib = null, fns = null, T = null;
  let api = null, device = null, gazeCb = null, pollTimer = null;
  let connected = false;

  function loadLibrary(dllPath) {
    // Ensure the DLL's own dir is on PATH so its sibling dependency DLLs resolve.
    const dllDir = path.dirname(dllPath);
    const parts = (process.env.PATH || "").split(path.delimiter);
    if (!parts.includes(dllDir)) process.env.PATH = dllDir + path.delimiter + (process.env.PATH || "");

    log(`koffi ${koffi.version || "?"}, arch=${process.arch}; loading ${dllPath}`);
    lib = koffi.load(dllPath);
    T = defineTypes();

    const apiPtr = koffi.pointer(T.api);
    const apiPtrPtr = koffi.pointer(T.api, 2);
    const devicePtr = koffi.pointer(T.device);
    const devicePtrPtr = koffi.pointer(T.device, 2);

    fns = {
      apiCreate: lib.func("tobii_api_create", "int", [koffi.out(apiPtrPtr), "void *", "void *"]),
      enumerate: lib.func("tobii_enumerate_local_device_urls", "int",
        [apiPtr, koffi.pointer(T.urlReceiver), "void *"]),
      deviceCreate: lib.func("tobii_device_create", "int",
        [apiPtr, "str", "int", koffi.out(devicePtrPtr)]),
      gazeSubscribe: lib.func("tobii_gaze_point_subscribe", "int",
        [devicePtr, koffi.pointer(T.gazeCallback), "void *"]),
      processCallbacks: lib.func("tobii_device_process_callbacks", "int", [devicePtr]),
      gazeUnsubscribe: lib.func("tobii_gaze_point_unsubscribe", "int", [devicePtr]),
      deviceDestroy: lib.func("tobii_device_destroy", "int", [devicePtr]),
      apiDestroy: lib.func("tobii_api_destroy", "int", [apiPtr]),
    };
  }

  return {
    get connected() { return connected; },

    start(dllPath, { onGaze, onStatus }) {
      if (!dllPath || !fs.existsSync(dllPath)) {
        onStatus("dll_not_found", `DLL not found: ${dllPath || "(none)"}`);
        return false;
      }
      try {
        loadLibrary(dllPath);
      } catch (e) {
        onStatus("dll_load_error", `Failed to load DLL: ${e && e.message}`);
        return false;
      }

      // Create API
      const apiOut = [null];
      log(">>> tobii_api_create");
      let err = fns.apiCreate(apiOut, null, null);
      api = apiOut[0];
      if (err !== 0 || !api) {
        onStatus("api_init_error", `tobii_api_create err=${errName(err)} api=${api ? "ok" : "NULL"}`);
        return false;
      }

      // Enumerate -> first device URL
      let foundUrl = null;
      const urlCb = koffi.register((url) => { if (!foundUrl) foundUrl = url; },
        koffi.pointer(T.urlReceiver));
      log(">>> tobii_enumerate_local_device_urls");
      err = fns.enumerate(api, urlCb, null);
      try { koffi.unregister(urlCb); } catch { /* ignore */ }
      if (err !== 0) { onStatus("enumerate_error", `enumerate err=${errName(err)}`); return false; }
      if (!foundUrl) { onStatus("no_device", "No eye-tracker device found"); return false; }

      // Create device
      const devOut = [null];
      log(`>>> tobii_device_create (${foundUrl})`);
      err = fns.deviceCreate(api, foundUrl, 1 /* INTERACTIVE */, devOut);
      device = devOut[0];
      if (err !== 0 || !device) {
        onStatus("device_error", `tobii_device_create err=${errName(err)}`);
        return false;
      }

      // Subscribe to gaze. The callback body must never throw into native code.
      gazeCb = koffi.register((gazePtr) => {
        try {
          if (!gazePtr) return;
          const gp = koffi.decode(gazePtr, T.gazePoint);
          onGaze({
            gazePoint: { x: gp.position_xy[0], y: gp.position_xy[1] },
            validity: gp.validity === 1 ? 1 : 0,
            timestamp: gp.timestamp_us,
          });
        } catch (e) {
          log(`ERROR in gaze callback: ${e && e.message}`);
        }
      }, koffi.pointer(T.gazeCallback));

      log(">>> tobii_gaze_point_subscribe");
      err = fns.gazeSubscribe(device, gazeCb, null);
      if (err !== 0) { onStatus("subscribe_error", `subscribe err=${errName(err)}`); return false; }

      // Poll for callbacks (~60fps)
      pollTimer = setInterval(() => {
        try { fns.processCallbacks(device); }
        catch (e) { log(`process_callbacks error: ${e && e.message}`); }
      }, 16);

      connected = true;
      onStatus("connected", `Connected: ${foundUrl}`, { deviceUrl: foundUrl });
      return true;
    },

    stop() {
      if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
      try { if (device && fns) fns.gazeUnsubscribe(device); } catch { /* ignore */ }
      try { if (device && fns) fns.deviceDestroy(device); } catch { /* ignore */ }
      try { if (api && fns) fns.apiDestroy(api); } catch { /* ignore */ }
      try { if (gazeCb) koffi.unregister(gazeCb); } catch { /* ignore */ }
      gazeCb = null; device = null; api = null; connected = false;
    },
  };
}

// ============================================================================
// Core: WebSocket + /status server, gaze broadcast, reconnect loop
// ============================================================================

const driver = drivers[DEVICE];
if (!driver) {
  log(`Unknown device "${DEVICE}". Known: ${Object.keys(drivers).join(", ")}`);
  process.exit(2);
}

const clients = new Set();
let lastStatus = { code: "starting", message: "Initializing..." };
let lastGaze = null;
let gazeCount = 0;
let reconnectTimer = null;

const server = http.createServer((req, res) => {
  if (req.url && req.url.startsWith("/status")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      device: DEVICE,
      connected: driver.connected,
      status: lastStatus,
      gazeCount,
      lastGaze,
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});

const wss = new WebSocketServer({ server });
wss.on("connection", (ws) => {
  clients.add(ws);
  ws.send(JSON.stringify({ type: "status", ...lastStatus }));
  ws.on("close", () => clients.delete(ws));
  ws.on("error", () => clients.delete(ws));
});

function broadcast(obj) {
  const json = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(json);
  }
}

function onGaze(data) {
  gazeCount++;
  lastGaze = data;
  broadcast(data);
}

function onStatus(code, message, extra = {}) {
  lastStatus = { code, message, ...extra };
  log(`STATUS ${code}: ${message}`);
  broadcast({ type: "status", ...lastStatus });
}

function tryConnect() {
  if (driver.connected) return;
  let ok = false;
  try {
    ok = driver.start(DLL_PATH, { onGaze, onStatus });
  } catch (e) {
    onStatus("error", `driver.start threw: ${e && e.message}`);
    ok = false;
  }
  if (!ok) {
    // Make sure any partial state is torn down before the next attempt.
    try { driver.stop(); } catch { /* ignore */ }
    scheduleReconnect();
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    tryConnect();
  }, RECONNECT_MS);
}

server.on("error", (e) => {
  log(`HTTP/WS server error: ${e && e.message}`);
  // Port in use or similar — exit so the supervisor can react.
  process.exit(3);
});

server.listen(PORT, "127.0.0.1", () => {
  const addr = server.address();
  const actualPort = addr && typeof addr === "object" ? addr.port : PORT;
  log(`listening on http://127.0.0.1:${actualPort} (ws + /status); dll=${DLL_PATH || "(auto/none)"}`);
  // Tell the supervisor which port the OS gave us, so the renderer can connect
  // without a hardcoded port. No-op when run standalone (no IPC channel).
  try { if (process.send) process.send({ type: "gaze-sidecar-listening", port: actualPort }); }
  catch { /* ignore */ }
  tryConnect();
});

// Clean shutdown
function shutdown() {
  try { driver.stop(); } catch { /* ignore */ }
  try { wss.close(); } catch { /* ignore */ }
  try { server.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
// When spawned with an ipc channel, exit if the parent disconnects.
process.on("disconnect", shutdown);
