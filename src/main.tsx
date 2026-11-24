import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import StorageGate from "./StorageGate";
import { applyTheme, readTheme, applyBackground, readBackground } from "./theme";

applyTheme(readTheme());
applyBackground(readBackground());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <StorageGate><App /></StorageGate>
  </React.StrictMode>,
);
