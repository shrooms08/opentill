import { createRoot } from "react-dom/client";
import "../shared/fonts.css";
import "../shared/tokens.css";
import "../shared/ui.css";
import "../shared/checkout.css";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(<App />);
