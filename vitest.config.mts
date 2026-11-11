import { defineConfig } from "vitest/config";
import path from "path";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Match the tsconfig "@/*" alias (→ project root).
    alias: [
      { find: /^@\/(.*)/, replacement: `${path.resolve(import.meta.dirname)}/$1` },
    ],
  },
  test: {
    environment: "node",
    include: ["**/__tests__/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.tsx"],
  },
});
