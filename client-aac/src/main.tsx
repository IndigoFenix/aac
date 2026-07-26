import { createRoot } from "react-dom/client";
import App from "./App";
import "./index.css";
import { install as installDebugLog } from "./lib/debug-log";

// Capture console + global errors into the in-app debug buffer BEFORE the app
// renders, so the earliest boot errors are visible on devices with no attached
// inspector (the sideloaded iPad build). See lib/debug-log.ts + DebugConsole.tsx.
installDebugLog();

createRoot(document.getElementById("root")!).render(<App />);
