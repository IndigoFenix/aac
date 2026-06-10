import { createRoot } from "react-dom/client";
import GoalTreePlayerApp from "./GoalTreePlayerApp";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<GoalTreePlayerApp />);
