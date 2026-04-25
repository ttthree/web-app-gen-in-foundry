import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@web-app-gen/contracts": fileURLToPath(new URL("./packages/contracts/src/index.ts", import.meta.url)),
    },
  },
  test: {
    include: ["{agent,cli,control-plane,packages}/**/*.test.ts"],
    exclude: ["**/dist/**", "**/node_modules/**"],
  },
});
