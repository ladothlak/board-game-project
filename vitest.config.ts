import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    // Match the tsconfig "@/*" alias (→ project root).
    alias: [
      { find: /^@\/(.*)/, replacement: `${path.resolve(__dirname)}/$1` },
    ],
  },
  test: {
    environment: "node",
    include: ["**/__tests__/**/*.test.ts"],
  },
});
