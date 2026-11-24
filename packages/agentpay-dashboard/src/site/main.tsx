import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Site } from "./Site.js";
import "./site.css";

document.documentElement.classList.add("js");
createRoot(document.getElementById("root")!).render(<StrictMode><Site /></StrictMode>);
