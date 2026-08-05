import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const gateway = process.env.OPENTILL_GATEWAY_URL ?? "http://localhost:8080";

// Multi-page app: hosted checkout + merchant dashboard.
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      input: {
        checkout: fileURLToPath(new URL("./checkout.html", import.meta.url)),
        dashboard: fileURLToPath(new URL("./dashboard.html", import.meta.url)),
      },
    },
  },
  server: {
    proxy: {
      "/api": gateway,
      "/dev": gateway,
      // Browser navigations (Accept: text/html) render the local dev pages
      // with HMR; data requests (JSON + SSE) fall through to the gateway.
      "/pay": {
        target: gateway,
        bypass(req) {
          if (req.headers.accept?.includes("text/html")) return "/checkout.html";
          return undefined;
        },
      },
      "/dashboard": {
        target: gateway,
        bypass(req) {
          if (req.headers.accept?.includes("text/html")) return "/dashboard.html";
          return undefined;
        },
      },
    },
  },
});
