/**
 * tobii-bridge.js — Tobii Eye Tracker Hardware Bridge
 *
 * This is the KEY FILE for hardware integration. It connects to a Tobii device
 * via the Tobii Stream Engine DLL and broadcasts gaze data over a local WebSocket.
 *
 * The renderer (index.html) connects to this WebSocket to get gaze coordinates.
 *
 * ARCHITECTURE:
 *   Tobii Device  →  Stream Engine DLL (via koffi FFI)  →  This Bridge  →  WebSocket  →  Renderer
 *
 * If you need to fine-tune the connection, focus on:
 *   1. DLL_SEARCH_PATHS — Where to find the Tobii DLL on your system
 *   2. The koffi type definitions — Must match the actual DLL's API
 *   3. POLL_INTERVAL_MS — How often to check for new gaze data
 */

const { WebSocketServer, WebSocket } = require("ws");
const path = require("path");
const fs = require("fs");
const os = require("os");

// ============================================================================
// LOGGING — mirror to console AND append to a file so the log can be shared
// ============================================================================

let LOG_FILE = path.join(os.tmpdir(), "tobii-bridge-debug.log");

/** Point logging at a specific file (called by main.js with the userData path). */
function setLogFile(p) {
  if (!p) return;
  LOG_FILE = p;
  try { fs.writeFileSync(LOG_FILE, ""); } catch { /* ignore */ } // fresh log per launch
}

function log(...args) {
  const line = "[" + new Date().toISOString() + "] " +
    args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + "\n"); } catch { /* ignore */ }
}

/**
 * tobii_error_t — maps the integer return codes to readable names.
 * Codes 0-17 are stable across Stream Engine versions; higher codes may vary.
 */
const TOBII_ERRORS = {
  0: "NO_ERROR", 1: "INTERNAL", 2: "INSUFFICIENT_LICENSE", 3: "NOT_SUPPORTED",
  4: "NOT_AVAILABLE", 5: "CONNECTION_FAILED", 6: "TIMED_OUT", 7: "ALLOCATION_FAILED",
  8: "INVALID_PARAMETER", 9: "CALIBRATION_ALREADY_STARTED", 10: "CALIBRATION_NOT_STARTED",
  11: "ALREADY_SUBSCRIBED", 12: "NOT_SUBSCRIBED", 13: "OPERATION_FAILED",
  14: "CONFLICTING_API_INSTANCES", 15: "CALIBRATION_BUSY", 16: "CALLBACK_IN_PROGRESS",
  17: "TOO_MANY_SUBSCRIBERS", 18: "CONNECTION_FAILED_DRIVER", 19: "UNAUTHORIZED",
};
function tobiiErr(code) {
  const name = TOBII_ERRORS[code];
  return name ? `${code} (TOBII_ERROR_${name})` : `${code} (unknown)`;
}

// ============================================================================
// CONFIGURATION — Change these if needed
// ============================================================================

/** Port for the local WebSocket server (renderer connects here) */
const WS_PORT = 49152;

/** How often (ms) to poll the Tobii device for new gaze data. 16ms ≈ 60fps */
const POLL_INTERVAL_MS = 16;

/**
 * Paths to search for the Tobii Stream Engine DLL.
 * The DLL ships with "Tobii Experience" / "Tobii Eye Tracking Core Software".
 * Add your path here if the DLL is somewhere else on your system.
 */
const DLL_SEARCH_PATHS = [
  // Tobii Eye Tracker 5 / IS5 typical locations
  "C:\\Program Files\\Tobii\\Tobii EyeX\\tobii_stream_engine.dll",
  "C:\\Program Files (x86)\\Tobii\\Tobii EyeX\\tobii_stream_engine.dll",
  // Tobii Stream Engine SDK standalone install
  "C:\\Program Files\\Tobii\\Tobii Stream Engine\\tobii_stream_engine.dll",
  "C:\\Program Files (x86)\\Tobii\\Tobii Stream Engine\\tobii_stream_engine.dll",
  // Tobii Experience (newer installations)
  "C:\\Program Files\\Tobii\\Tobii Experience\\tobii_stream_engine.dll",
  // Common dev/SDK locations
  "C:\\tobii\\tobii_stream_engine.dll",
  // Relative to this app (if you copy the DLL here)
  path.join(__dirname, "tobii_stream_engine.dll"),
];

// ============================================================================
// TOBII STREAM ENGINE CONNECTION (via koffi FFI)
// ============================================================================

/**
 * Find the Tobii Stream Engine DLL on the system.
 * Returns the path or null if not found.
 */
function findTobiiDLL() {
  for (const p of DLL_SEARCH_PATHS) {
    if (fs.existsSync(p)) {
      console.log(`[TobiiBridge] Found DLL: ${p}`);
      return p;
    }
  }

  // Also try the system PATH
  const pathDirs = (process.env.PATH || "").split(";");
  for (const dir of pathDirs) {
    const p = path.join(dir, "tobii_stream_engine.dll");
    if (fs.existsSync(p)) {
      console.log(`[TobiiBridge] Found DLL in PATH: ${p}`);
      return p;
    }
  }

  return null;
}

/**
 * TobiiBridge — connects to a Tobii device and emits gaze data.
 *
 * Usage:
 *   const bridge = new TobiiBridge();
 *   bridge.onGaze = (data) => { console.log(data.gazePoint.x, data.gazePoint.y); };
 *   await bridge.start();
 */
class TobiiBridge {
  constructor() {
    this.onGaze = null; // Callback: (gazeData) => void
    this.onStatus = null; // Callback: (status) => void
    this._koffi = null;
    this._lib = null;
    this._api = null;
    this._device = null;
    this._pollTimer = null;
    this._deviceUrl = null;
    this._dllPath = null;
    this._connected = false;
    this._gazeCallback = null; // koffi registered callback — must prevent GC
  }

  get connected() {
    return this._connected;
  }

  /** The DLL path currently in use (null if not connected). */
  get dllPath() {
    return this._dllPath;
  }

  /**
   * Connect to the Tobii device.
   * @param {string|null} explicitDllPath - If provided and the file exists, this
   *   DLL is used directly. Otherwise the DLL_SEARCH_PATHS list is searched.
   */
  async start(explicitDllPath) {
    // Step 1: Find the DLL — prefer an explicitly chosen path, else auto-detect
    const dllPath = (explicitDllPath && fs.existsSync(explicitDllPath))
      ? explicitDllPath
      : findTobiiDLL();
    if (!dllPath) {
      this._emitStatus("dll_not_found",
        "Tobii Stream Engine DLL not found. Use the \"Select DLL\" button to pick " +
        "tobii_stream_engine.dll, or copy it into this app's folder.");
      return false;
    }
    this._dllPath = dllPath;

    // Step 2: Load koffi
    try {
      this._koffi = require("koffi");
    } catch (e) {
      this._emitStatus("koffi_error",
        `Failed to load koffi: ${e.message}. Try: npm run rebuild`);
      return false;
    }

    // Step 3: Load the DLL and define types
    try {
      this._loadLibrary(dllPath);
    } catch (e) {
      this._emitStatus("dll_load_error",
        `Failed to load DLL: ${e.message}`);
      return false;
    }

    // Step 4: Initialize the Tobii API
    try {
      this._initAPI();
    } catch (e) {
      this._emitStatus("api_init_error",
        `Failed to initialize Tobii API: ${e.message}`);
      return false;
    }

    // Step 5: Find and connect to a device
    try {
      this._connectDevice();
    } catch (e) {
      this._emitStatus("device_error",
        `Failed to connect to Tobii device: ${e.message}. Is the device plugged in?`);
      return false;
    }

    // Step 6: Subscribe to gaze data
    try {
      this._subscribeGaze();
    } catch (e) {
      this._emitStatus("subscribe_error",
        `Failed to subscribe to gaze data: ${e.message}`);
      return false;
    }

    // Step 7: Start polling for callbacks
    this._startPolling();

    this._connected = true;
    this._emitStatus("connected", `Connected to Tobii device: ${this._deviceUrl}`,
      { dllPath: this._dllPath });
    return true;
  }

  stop() {
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }

    if (this._device && this._fn_gaze_unsubscribe) {
      try { this._fn_gaze_unsubscribe(this._device); } catch (e) { /* ignore */ }
    }
    if (this._device && this._fn_device_destroy) {
      try { this._fn_device_destroy(this._device); } catch (e) { /* ignore */ }
    }
    if (this._api && this._fn_api_destroy) {
      try { this._fn_api_destroy(this._api); } catch (e) { /* ignore */ }
    }

    // Release the registered FFI callback so reconnects don't exhaust koffi's
    // limited callback pool.
    if (this._koffi && this._gazeCallback) {
      try { this._koffi.unregister(this._gazeCallback); } catch (e) { /* ignore */ }
    }
    this._gazeCallback = null;

    this._connected = false;
    this._device = null;
    this._api = null;
  }

  // ── Internal: Load DLL and define FFI types ──

  _loadLibrary(dllPath) {
    const koffi = this._koffi;

    // tobii_stream_engine.dll has sibling dependency DLLs. The Windows loader
    // searches the app directory by default, NOT the DLL's own folder, so a load
    // from an arbitrary path can fail with a missing-dependency error. Prepend
    // the DLL's directory to PATH so its dependencies resolve.
    const dllDir = path.dirname(dllPath);
    const pathParts = (process.env.PATH || "").split(path.delimiter);
    if (!pathParts.includes(dllDir)) {
      process.env.PATH = dllDir + path.delimiter + (process.env.PATH || "");
    }

    // Load the native library
    log(`[TobiiBridge] koffi version: ${koffi.version || "unknown"}; process.arch=${process.arch}`);
    log(`[TobiiBridge] Loading DLL: ${dllPath}`);
    this._lib = koffi.load(dllPath);

    // ── Type definitions ──
    // koffi registers named types (struct/proto/opaque) GLOBALLY for the whole
    // process. Defining them again on a reconnect throws "Duplicate type name",
    // so define them exactly once and reuse the handles on every (re)load.
    if (!TobiiBridge._types) {
      TobiiBridge._types = {
        // Opaque HANDLE types (tobii_api_t, tobii_device_t). Using opaque named
        // types — NOT void* — is what lets koffi marshal the output handles back.
        // The void*/alloc attempts crashed or returned null; this is the
        // documented opaque-type pattern (see koffi doc/pages/output.md).
        api: koffi.opaque("tobii_api_t"),
        device: koffi.opaque("tobii_device_t"),
        // tobii_gaze_point_t:
        //   int64_t timestamp_us; int validity (0/1); float position_xy[2] (0-1)
        gazePoint: koffi.struct("tobii_gaze_point_t", {
          timestamp_us: "int64",
          validity: "int",
          position_xy: koffi.array("float", 2),
        }),
        // URL receiver: called once per found device with the device URL string
        urlReceiver: koffi.proto(
          "void tobii_url_receiver(const char* url, void* user_data)"
        ),
        // Gaze point callback: called when new gaze data is available
        gazeCallback: koffi.proto(
          "void tobii_gaze_cb(const tobii_gaze_point_t* gaze_point, void* user_data)"
        ),
      };
    }
    const T = TobiiBridge._types;
    this._GazePointStruct = T.gazePoint;
    this._UrlReceiverProto = T.urlReceiver;
    this._GazeCallbackProto = T.gazeCallback;

    // Pointer types derived from the opaque handles. koffi.pointer(type, 2) is a
    // double pointer (the "2" is the indirection level) used for output handles.
    const apiPtr = koffi.pointer(T.api);            // tobii_api_t*
    const apiPtrPtr = koffi.pointer(T.api, 2);      // tobii_api_t**  (output)
    const devicePtr = koffi.pointer(T.device);      // tobii_device_t*
    const devicePtrPtr = koffi.pointer(T.device, 2); // tobii_device_t** (output)

    // ── Function declarations (tied to THIS lib handle — recreate each load) ──
    const lib = this._lib;

    // Output handles: koffi.out() on the double-pointer copies the created handle
    // back into the JS array's [0] slot after the call.
    this._fn_api_create = lib.func("tobii_api_create", "int",
      [koffi.out(apiPtrPtr), "void *", "void *"]);

    // Callback params must be an explicit pointer to the registered proto type.
    this._fn_enumerate = lib.func("tobii_enumerate_local_device_urls", "int",
      [apiPtr, koffi.pointer(this._UrlReceiverProto), "void *"]);

    this._fn_device_create = lib.func("tobii_device_create", "int",
      [apiPtr, "str", "int", koffi.out(devicePtrPtr)]);

    this._fn_gaze_subscribe = lib.func("tobii_gaze_point_subscribe", "int",
      [devicePtr, koffi.pointer(this._GazeCallbackProto), "void *"]);

    this._fn_process_callbacks = lib.func("tobii_device_process_callbacks", "int",
      [devicePtr]);

    this._fn_gaze_unsubscribe = lib.func("tobii_gaze_point_unsubscribe", "int",
      [devicePtr]);

    this._fn_device_destroy = lib.func("tobii_device_destroy", "int",
      [devicePtr]);

    this._fn_api_destroy = lib.func("tobii_api_destroy", "int",
      [apiPtr]);

    log("[TobiiBridge] Library loaded successfully");
  }

  // ── Internal: Initialize API ──

  _initAPI() {
    // koffi.out() on the tobii_api_t** parameter copies the created handle back
    // into apiOut[0] after the call.
    const apiOut = [null];
    log("[TobiiBridge] >>> calling tobii_api_create");
    const err = this._fn_api_create(apiOut, null, null);
    this._api = apiOut[0];
    log(`[TobiiBridge] tobii_api_create -> err=${tobiiErr(err)}, api=${this._api ? "non-null" : "NULL"}`);
    if (err !== 0) {
      throw new Error(`tobii_api_create returned error code ${tobiiErr(err)}`);
    }
    if (!this._api) {
      throw new Error("tobii_api_create reported success but returned a NULL api handle " +
        "(koffi did not write the out-parameter back)");
    }
    log("[TobiiBridge] API initialized");
  }

  // ── Internal: Find and connect to device ──

  _connectDevice() {
    // Enumerate devices — the callback receives each device URL
    let foundUrl = null;
    // koffi.register's second arg must be a POINTER to the callback prototype
    // (koffi.pointer(proto)), not the bare proto — otherwise koffi throws
    // "Unexpected <name> type, expected <callback> * type".
    const urlCallback = this._koffi.register((url, _userData) => {
      if (!foundUrl) {
        foundUrl = url;
        console.log(`[TobiiBridge] Found device: ${url}`);
      }
    }, this._koffi.pointer(this._UrlReceiverProto));

    log(`[TobiiBridge] enumerating devices (api=${this._api ? "non-null" : "NULL"})...`);
    const err = this._fn_enumerate(this._api, urlCallback, null);
    // The url receiver is only needed for the duration of the enumerate call.
    try { this._koffi.unregister(urlCallback); } catch (e) { /* ignore */ }
    log(`[TobiiBridge] tobii_enumerate_local_device_urls -> err=${tobiiErr(err)}, foundUrl=${foundUrl || "(none)"}`);
    if (err !== 0) {
      throw new Error(`tobii_enumerate_local_device_urls returned error code ${tobiiErr(err)}`);
    }

    if (!foundUrl) {
      throw new Error("No Tobii device found. Is it plugged in and recognized by the system?");
    }

    this._deviceUrl = foundUrl;

    // Create device handle
    // field_of_use: 1 = TOBII_FIELD_OF_USE_INTERACTIVE (required for consumer trackers)
    const deviceOut = [null];
    log(`[TobiiBridge] >>> calling tobii_device_create (url=${foundUrl})`);
    const err2 = this._fn_device_create(this._api, foundUrl, 1, deviceOut);
    this._device = deviceOut[0];
    log(`[TobiiBridge] tobii_device_create -> err=${tobiiErr(err2)}, device=${this._device ? "non-null" : "NULL"}`);
    if (err2 !== 0) {
      throw new Error(`tobii_device_create returned error code ${tobiiErr(err2)}`);
    }
    log("[TobiiBridge] Device connected");
  }

  // ── Internal: Subscribe to gaze data ──

  _subscribeGaze() {
    // Register the gaze callback — koffi will call this from C. The body MUST
    // NOT throw: an exception propagating back into native code crashes the
    // process, so everything is wrapped in try/catch.
    this._gazeFired = false;
    this._gazeCallback = this._koffi.register((gazePoint, _userData) => {
      try {
        if (!gazePoint) return;

        // koffi passes pointer arguments to callbacks as opaque External objects
        // (it can't know how to decode them). Decode it into the struct here.
        const gp = this._koffi.decode(gazePoint, this._GazePointStruct);

        if (!this._gazeFired) {
          this._gazeFired = true;
          log(`[TobiiBridge] first gaze callback OK: validity=${gp.validity} xy=[${gp.position_xy[0]},${gp.position_xy[1]}]`);
        }

        // gp is the decoded tobii_gaze_point_t:
        //   .timestamp_us (int64), .validity (0/1), .position_xy (float[2], 0-1)
        const data = {
          gazePoint: {
            x: gp.position_xy[0],
            y: gp.position_xy[1],
          },
          validity: gp.validity === 1 ? 1.0 : 0.0,
          timestamp: gp.timestamp_us,
        };

        if (this.onGaze) this.onGaze(data);
      } catch (e) {
        log(`[TobiiBridge] ERROR inside gaze callback: ${e && e.message}`);
      }
    }, this._koffi.pointer(this._GazeCallbackProto));

    log("[TobiiBridge] >>> calling tobii_gaze_point_subscribe");
    const err = this._fn_gaze_subscribe(this._device, this._gazeCallback, null);
    log(`[TobiiBridge] tobii_gaze_point_subscribe -> err=${tobiiErr(err)}`);
    if (err !== 0) {
      throw new Error(`tobii_gaze_point_subscribe returned error code ${tobiiErr(err)}`);
    }
    log("[TobiiBridge] Subscribed to gaze data");
  }

  // ── Internal: Poll for callbacks ──

  _startPolling() {
    // tobii_device_process_callbacks is non-blocking — it processes any pending
    // callbacks from the device. We call it on a timer (~60fps).
    log("[TobiiBridge] >>> starting poll loop (tobii_device_process_callbacks)");
    let firstPoll = true;
    this._pollTimer = setInterval(() => {
      try {
        this._fn_process_callbacks(this._device);
        if (firstPoll) {
          firstPoll = false;
          log("[TobiiBridge] first process_callbacks OK");
        }
      } catch (e) {
        log(`[TobiiBridge] process_callbacks error: ${e && e.message}`);
      }
    }, POLL_INTERVAL_MS);
  }

  _emitStatus(code, message, extra = {}) {
    log(`[TobiiBridge] STATUS ${code}: ${message}`);
    if (this.onStatus) {
      this.onStatus({ code, message, ...extra });
    }
  }
}

// ============================================================================
// WEBSOCKET SERVER — Broadcasts gaze data to the renderer
// ============================================================================

/**
 * Start the complete Tobii bridge + WebSocket server.
 *
 * Returns { bridge, wss, status } where:
 *   - bridge: The TobiiBridge instance (null if hardware connection failed)
 *   - wss: The WebSocket server (always started, even if bridge fails)
 *   - status: Current status string
 */
async function startTobiiBridge(initialDllPath, options = {}) {
  if (options.logFile) setLogFile(options.logFile);
  log(`[TobiiBridge] === startup === logFile=${LOG_FILE}`);
  const clients = new Set();
  let lastStatus = { code: "starting", message: "Initializing..." };
  let lastGaze = null;
  let gazeCount = 0;

  // Start WebSocket server (always, even if bridge fails — renderer can fall back to mouse)
  const wss = new WebSocketServer({ port: WS_PORT, host: "127.0.0.1" });
  console.log(`[TobiiBridge] WebSocket server listening on ws://127.0.0.1:${WS_PORT}`);

  wss.on("connection", (ws) => {
    clients.add(ws);
    console.log(`[TobiiBridge] Client connected (${clients.size} total)`);

    // Send current status to new client
    ws.send(JSON.stringify({ type: "status", ...lastStatus }));

    ws.on("close", () => {
      clients.delete(ws);
      console.log(`[TobiiBridge] Client disconnected (${clients.size} total)`);
    });

    // Handle messages from renderer (e.g., configuration changes)
    ws.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong", gazeCount }));
        }
      } catch { /* ignore */ }
    });
  });

  // Broadcast helper
  function broadcast(data) {
    const json = JSON.stringify(data);
    for (const ws of clients) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(json);
      }
    }
  }

  // Attempt to start the Tobii bridge
  const bridge = new TobiiBridge();

  bridge.onStatus = (status) => {
    lastStatus = status;
    broadcast({ type: "status", ...status });
  };

  bridge.onGaze = (gazeData) => {
    gazeCount++;
    lastGaze = gazeData;
    // Broadcast in the format that parseTobii in websocket-bridge-provider.ts expects
    broadcast(gazeData);
  };

  const success = await bridge.start(initialDllPath);

  if (!success) {
    console.log("[TobiiBridge] Hardware connection failed — renderer will use mouse fallback");
    broadcast({
      type: "status",
      code: "fallback",
      message: "Tobii not connected. Using mouse as gaze source. Check the log for details.",
    });
  }

  /**
   * Stop the current connection and reconnect, optionally with a new DLL path.
   * Lets the user point the app at a hand-picked tobii_stream_engine.dll without
   * restarting the whole app. Pass null to fall back to auto-detection.
   * @param {string|null} dllPath
   * @returns {Promise<{connected:boolean, dllPath:string|null, status:object}>}
   */
  async function reconnectWithDll(dllPath) {
    console.log(`[TobiiBridge] Reconnecting with DLL: ${dllPath || "(auto-detect)"}`);
    try { bridge.stop(); } catch { /* ignore */ }

    const ok = await bridge.start(dllPath || undefined);
    if (!ok) {
      broadcast({
        type: "status",
        code: "fallback",
        message: lastStatus.message ||
          "Tobii not connected with the selected DLL. Using mouse as gaze source.",
      });
    }
    return { connected: bridge.connected, dllPath: bridge.dllPath, status: lastStatus };
  }

  // Provide an HTTP status endpoint for probing (matches what createTobiiProvider expects)
  const http = require("http");
  const statusServer = http.createServer((req, res) => {
    if (req.url === "/status") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        connected: bridge.connected,
        status: lastStatus,
        gazeCount,
        lastGaze,
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  statusServer.listen(WS_PORT + 1, "127.0.0.1", () => {
    console.log(`[TobiiBridge] HTTP status at http://127.0.0.1:${WS_PORT + 1}/status`);
  });

  return { bridge, wss, statusServer, reconnectWithDll };
}

module.exports = {
  TobiiBridge,
  startTobiiBridge,
  WS_PORT,
  setLogFile,
  getLogFile: () => LOG_FILE,
};
