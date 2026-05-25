import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  test: {
    include: [
      "lib/**/*.test.ts",
      "lib/**/*.test.tsx",
      "tests/**/*.test.ts",
    ],
    environment: "node",
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
    // Default vitest timeout is 5 000 ms. With singleFork: true, the first
    // test that exceeds the timeout kills the sole worker fork and causes the
    // entire suite to report failure immediately. Slow operations such as
    // scrypt key derivation (N=2^17, ~2-5 s on CI) and daemon-ready waits
    // (up to 15 s) need more headroom. 60 s is well within the CI
    // timeout-minutes: 15 budget while still catching genuine hangs.
    testTimeout: 60_000,
    hookTimeout: 30_000,
    // Use N=1024 for scrypt in tests — reduces each vault save/load from ~3 s
    // to ~0.03 s without affecting correctness (tests exercise functionality,
    // not cryptographic strength). Production code ignores this variable.
    env: {
      SM_SCRYPT_N: "1024",
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
});
