TOBII DWELL TEST APP
====================

Tests eye-gaze button selection with a real Tobii device.
Mirrors the architecture from the main CliniAACian app.

ARCHITECTURE:
  Tobii Device → Stream Engine DLL → tobii-bridge.js → WebSocket → index.html (renderer)

If the Tobii connection fails, the app falls back to mouse input so you can
still test the dwell UI.


SETUP
-----
1. Install Node.js from https://nodejs.org (LTS version)
2. Open a terminal in this folder
3. Run:  npm install
4. If koffi rebuild fails, run:  npm run rebuild
5. Run:  npm start


WHAT YOU SHOULD SEE
-------------------
- Status bar shows "Tobii Connected" (green) or "Mouse Fallback" (yellow)
- A blue dot follows your gaze (or mouse)
- Look at a button — a blue border animates around it as you dwell
- When the border completes, the button is selected (beep + log entry)


IF TOBII IS NOT DETECTED
-------------------------
The app will say "Tobii not connected" and fall back to mouse.
Check these things:

1. Is the Tobii device plugged in and recognized by Windows?
2. Is "Tobii Experience" (or "Tobii Eye Tracking Core") software installed and running?
3. The app needs tobii_stream_engine.dll. The EASIEST fix: click the
   "Select DLL…" button in the bar near the top of the app, browse to the
   DLL, and the app reconnects immediately (no restart). Your choice is
   remembered for next launch. Click "Auto-detect" to forget it again.

   If you prefer to hard-code paths instead, open tobii-bridge.js and edit
   the DLL_SEARCH_PATHS array.

   To find the DLL, search your PC:
   - Open File Explorer
   - Go to C:\Program Files and C:\Program Files (x86)
   - Search for "tobii_stream_engine.dll"
   - Add the path to DLL_SEARCH_PATHS in tobii-bridge.js

   Or just copy the DLL file into this app's folder (next to main.js).


FILES
-----
  tobii-bridge.js  ← MAIN FILE TO EDIT for hardware connection
  index.html       ← MAIN FILE TO EDIT for UI / dwell tuning
  main.js          ← Electron window setup (rarely needs changes)
  preload.js       ← IPC bridge (don't change)
  package.json     ← Dependencies


TUNING THE DWELL (in index.html)
---------------------------------
Open index.html and find the CONFIG section near the top of the <script> tag.
You can also use the sliders in the app.

  DWELL_TIME_MS  — How long (ms) to look at a button to select it.
                   Start high (1500-2000) and lower as you get comfortable.
  COOLDOWN_MS    — Pause after selection before another can happen.
  GAZE_SMOOTHING — Higher = smoother but slower to react. Lower = jittery but responsive.
  COLUMNS        — Number of columns in the button grid.

CHANGING BUTTONS (in index.html):
  Find the BUTTONS array. Each entry has label and color (hex).
  Add/remove entries freely.


TUNING THE TOBII CONNECTION (in tobii-bridge.js)
-------------------------------------------------
  DLL_SEARCH_PATHS — Where to look for tobii_stream_engine.dll
  WS_PORT          — WebSocket port (default 49152, must match index.html)
  POLL_INTERVAL_MS — How often to poll device (16ms = ~60fps)


TROUBLESHOOTING WITH AI
------------------------
Tell your AI:
- "The DLL isn't found" → Search for tobii_stream_engine.dll on the PC, add path to DLL_SEARCH_PATHS
- "koffi won't install" → Run: npm run rebuild    or try: npx electron-rebuild -f -w koffi
- "Device not found but is plugged in" → The koffi FFI types might not match the DLL version.
  Ask AI to check the struct definitions in tobii-bridge.js against the Tobii Stream Engine docs.
- "Gaze data comes but coordinates are wrong" → The DLL returns normalized 0-1 coords.
  Check the gazePoint.x/y mapping in tobii-bridge.js _subscribeGaze().
- "Selection triggers too easily" → Increase DWELL_TIME_MS
- "Too jittery" → Increase GAZE_SMOOTHING
- "Can't select fast enough" → Decrease DWELL_TIME_MS and COOLDOWN_MS
- "Gaze dot is offset from where I look" → This is a Tobii calibration issue.
  Recalibrate in the Tobii Experience software.


ONCE IT WORKS
-------------
The key pieces to bring back to the main project:
1. The Tobii bridge code (tobii-bridge.js) → goes in electron/hardware/tobii-bridge.js
2. The DLL path detection and koffi FFI bindings
3. Any tweaks to dwell timing / smoothing values


BUILDING A STANDALONE .EXE
---------------------------
  npm run build
  The .exe appears in the "dist" folder.
