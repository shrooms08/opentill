import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@opentill/shared": r("./packages/shared/src/index.ts"),
      "@opentill/adapter": r("./packages/adapter/src/index.ts"),
    },
  },
  test: {
    include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.{ts,tsx}"],
    environment: "node",
    testTimeout: 20000,
    hookTimeout: 20000,
    pool: "forks",
  },
});
