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
    this._connected = false;
    this._gazeCallback = null; // koffi registered callback — must prevent GC
  }

  get connected() {
    return this._connected;
  }

  async start() {
    // Step 1: Find the DLL
    const dllPath = findTobiiDLL();
    if (!dllPath) {
      this._emitStatus("dll_not_found",
        "Tobii Stream Engine DLL not found. See DLL_SEARCH_PATHS in tobii-bridge.js. " +
        "You can also copy tobii_stream_engine.dll into this app's folder.");
      return false;
    }

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
    this._emitStatus("connected", `Connected to Tobii device: ${this._deviceUrl}`);
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

    this._connected = false;
    this._device = null;
    this._api = null;
  }

  // ── Internal: Load DLL and define FFI types ──

  _loadLibrary(dllPath) {
    const koffi = this._koffi;

    // Load the native library
    this._lib = koffi.load(dllPath);

    // ── Struct definitions ──
    // tobii_gaze_point_t: the data we get from the gaze subscription
    //   int64_t timestamp_us;
    //   int validity;          // 0 = INVALID, 1 = VALID
    //   float position_xy[2];  // normalized 0.0 - 1.0
    this._GazePointStruct = koffi.struct("tobii_gaze_point_t", {
      timestamp_us: "int64",
      validity: "int",
      position_xy: koffi.array("float", 2),
    });

    // ── Callback prototypes ──
    // URL receiver: called once per found device with the device URL string
    this._UrlReceiverProto = koffi.proto(
      "void tobii_url_receiver(const char* url, void* user_data)"
    );

    // Gaze point callback: called when new gaze data is available
    this._GazeCallbackProto = koffi.proto(
      "void tobii_gaze_cb(const tobii_gaze_point_t* gaze_point, void* user_data)"
    );

    // ── Function declarations ──
    const lib = this._lib;

    this._fn_api_create = lib.func(
      "int tobii_api_create(void** api, void* alloc, void* log)"
    );

    this._fn_enumerate = lib.func(
      "int tobii_enumerate_local_device_urls(void* api, tobii_url_receiver* receiver, void* user_data)"
    );

    this._fn_device_create = lib.func(
      "int tobii_device_create(void* api, const char* url, int field_of_use, void** device)"
    );

    this._fn_gaze_subscribe = lib.func(
      "int tobii_gaze_point_subscribe(void* device, tobii_gaze_cb* callback, void* user_data)"
    );

    this._fn_process_callbacks = lib.func(
      "int tobii_device_process_callbacks(void* device)"
    );

    this._fn_gaze_unsubscribe = lib.func(
      "int tobii_gaze_point_unsubscribe(void* device)"
    );

    this._fn_device_destroy = lib.func(
      "int tobii_device_destroy(void* device)"
    );

    this._fn_api_destroy = lib.func(
      "int tobii_api_destroy(void* api)"
    );

    console.log("[TobiiBridge] Library loaded successfully");
  }

  // ── Internal: Initialize API ──

  _initAPI() {
    const apiOut = [null];
    const err = this._fn_api_create(apiOut, null, null);
    if (err !== 0) {
      throw new Error(`tobii_api_create returned error code ${err}`);
    }
    this._api = apiOut[0];
    console.log("[TobiiBridge] API initialized");
  }

  // ── Internal: Find and connect to device ──

  _connectDevice() {
    // Enumerate devices — the callback receives each device URL
    let foundUrl = null;
    const urlCallback = this._koffi.register((url, _userData) => {
      if (!foundUrl) {
        foundUrl = url;
        console.log(`[TobiiBridge] Found device: ${url}`);
      }
    }, this._UrlReceiverProto);

    const err = this._fn_enumerate(this._api, urlCallback, null);
    if (err !== 0) {
      throw new Error(`tobii_enumerate_local_device_urls returned error code ${err}`);
    }

    if (!foundUrl) {
      throw new Error("No Tobii device found. Is it plugged in and recognized by the system?");
    }

    this._deviceUrl = foundUrl;

    // Create device handle
    // field_of_use: 1 = TOBII_FIELD_OF_USE_INTERACTIVE (required for consumer trackers)
    const deviceOut = [null];
    const err2 = this._fn_device_create(this._api, foundUrl, 1, deviceOut);
    if (err2 !== 0) {
      throw new Error(`tobii_device_create returned error code ${err2}`);
    }
    this._device = deviceOut[0];
    console.log("[TobiiBridge] Device connected");
  }

  // ── Internal: Subscribe to gaze data ──

  _subscribeGaze() {
    // Register the gaze callback — koffi will call this from C
    this._gazeCallback = this._koffi.register((gazePoint, _userData) => {
      if (!gazePoint) return;

      // gazePoint is a decoded tobii_gaze_point_t struct:
      //   .timestamp_us (int64)
      //   .validity (int: 0=invalid, 1=valid)
      //   .position_xy (float[2]: normalized 0-1)
      const data = {
        gazePoint: {
          x: gazePoint.position_xy[0], // 0.0 - 1.0 (normalized)
          y: gazePoint.position_xy[1], // 0.0 - 1.0 (normalized)
        },
        validity: gazePoint.validity === 1 ? 1.0 : 0.0,
        timestamp: gazePoint.timestamp_us,
      };

      if (this.onGaze) {
        this.onGaze(data);
      }
    }, this._GazeCallbackProto);

    const err = this._fn_gaze_subscribe(this._device, this._gazeCallback, null);
    if (err !== 0) {
      throw new Error(`tobii_gaze_point_subscribe returned error code ${err}`);
    }
    console.log("[TobiiBridge] Subscribed to gaze data");
  }

  // ── Internal: Poll for callbacks ──

  _startPolling() {
    // tobii_device_process_callbacks is non-blocking — it processes any pending
    // callbacks from the device. We call it on a timer (~60fps).
    this._pollTimer = setInterval(() => {
      try {
        this._fn_process_callbacks(this._device);
      } catch (e) {
        console.error("[TobiiBridge] process_callbacks error:", e.message);
      }
    }, POLL_INTERVAL_MS);
  }

  _emitStatus(code, message) {
    console.log(`[TobiiBridge] ${code}: ${message}`);
    if (this.onStatus) {
      this.onStatus({ code, message });
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
async function startTobiiBridge() {
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

  const success = await bridge.start();

  if (!success) {
    console.log("[TobiiBridge] Hardware connection failed — renderer will use mouse fallback");
    broadcast({
      type: "status",
      code: "fallback",
      message: "Tobii not connected. Using mouse as gaze source. Check the log for details.",
    });
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

  return { bridge, wss, statusServer };
}

module.exports = { TobiiBridge, startTobiiBridge, WS_PORT };
