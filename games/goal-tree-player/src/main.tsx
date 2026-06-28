import { createRoot } from "react-dom/client";
import GoalTreePlayerApp from "./GoalTreePlayerApp";
import GoalTreePlayer3D from "./GoalTreePlayer3D";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");

// ?render=3d selects the Phase-0 world-engine 3D spike; 2D is the default.
const use3D = new URLSearchParams(window.location.search).get("render") === "3d";
createRoot(root).render(use3D ? <GoalTreePlayer3D /> : <GoalTreePlayerApp />);
