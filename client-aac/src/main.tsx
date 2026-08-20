import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { install as installDebugLog } from "./lib/debug-log";
import { startBackendManifestSync } from "./lib/api-base";

// Capture console + global errors into the in-app debug buffer BEFORE the app
// renders, so the earliest boot errors are visible on devices with no attached
// inspector (the sideloaded iPad build). See lib/debug-log.ts + DebugConsole.tsx.
installDebugLog();

// Packaged apps: check the published backend manifest so the fleet can be
// re-pointed (e.g. Render → api.aivota.ai) without a new build. Non-blocking;
// a change applies on the next launch unless the current backend is down.
startBackendManifestSync();

createRoot(document.getElementById("root")!).render(<App />);
