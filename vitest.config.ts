import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      "server-only": fileURLToPath(
        new URL("./tests-ts/server-only.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["tests-ts/**/*.test.ts"],
    fileParallelism: false,
    testTimeout: 20000,
  },
});
