import { createRoot } from "react-dom/client";
import SocialTrainerApp from "./SocialTrainerApp";
import "./index.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root element");
createRoot(root).render(<SocialTrainerApp />);
