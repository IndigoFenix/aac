// Entry point for the standalone bubble-test harness (bubble-test.html).
import { createRoot } from "react-dom/client";
import BubbleTest from "./BubbleTest";

createRoot(document.getElementById("root")!).render(<BubbleTest />);
