import { defineConfig } from "vitest/config";

// Compiled copies in dist/ (tsc also emits tests) must never run: they go stale against the source.
export default defineConfig({ test: { testTimeout: 30000, exclude: ["dist/**", "node_modules/**", "**/vendor/**"] } });
