import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { PORTA_BASE_PATH } from "./basePath";
import "./index.css";
import App from "./App";
import {
  AppErrorBoundary,
  reloadOnceForStaleChunk,
} from "./components/AppErrorBoundary";

// Vite の遅延チャンクが更新ズレで 404 になった際、真っ暗クラッシュさせず自動で最新版へ更新
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  reloadOnceForStaleChunk();
});

// Unregister stale service workers and clear legacy cache to ensure latest Gemini mobile UI
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.getRegistrations().then((registrations) => {
    for (const r of registrations) {
      r.unregister();
    }
  });
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AppErrorBoundary>
      <BrowserRouter basename={PORTA_BASE_PATH}>
        <App />
      </BrowserRouter>
    </AppErrorBoundary>
  </StrictMode>,
);
