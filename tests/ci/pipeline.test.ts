import { describe, it, expect, beforeAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

// Resolve the repo root relative to this test file:
// tests/ci/pipeline.test.ts -> ../../ -> repo root
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "../..");
const WORKFLOW_PATH = path.join(REPO_ROOT, ".github", "workflows", "ci.yml");

describe("CI/CD pipeline (.github/workflows/ci.yml)", () => {
  it("workflow file exists", () => {
    const exists = fs.existsSync(WORKFLOW_PATH);
    expect(
      exists,
      `Expected .github/workflows/ci.yml to exist at ${WORKFLOW_PATH} — create it to fix issue #7`,
    ).toBe(true);
  });

  describe("workflow content", () => {
    let content = "";
    beforeAll(() => {
      if (!fs.existsSync(WORKFLOW_PATH)) {
        content = "";
        return;
      }
      content = fs.readFileSync(WORKFLOW_PATH, "utf8");
    });

    it("has push-to-main trigger", () => {
      expect(
        content,
        ".github/workflows/ci.yml does not exist yet",
      ).not.toBe("");
      // Accept either inline form "push:" with a branches block, or
      // explicit "branches: [main]" / "branches:\n      - main" patterns.
      const hasPushTrigger =
        /push:/.test(content) &&
        (/branches:\s*\[.*main.*\]/.test(content) ||
          /branches:[^\S\n]*\n\s*-\s*main/.test(content));
      expect(
        hasPushTrigger,
        "Expected workflow to trigger on push to main (push: branches: [main])",
      ).toBe(true);
    });

    it("has pull_request trigger", () => {
      expect(
        content,
        ".github/workflows/ci.yml does not exist yet",
      ).not.toBe("");
      expect(
        content,
        "Expected workflow to trigger on pull_request events",
      ).toMatch(/pull_request[:\s]/);
    });

    it("runs pnpm test", () => {
      expect(
        content,
        ".github/workflows/ci.yml does not exist yet",
      ).not.toBe("");
      expect(
        content,
        "Expected workflow to contain a step that runs 'pnpm test'",
      ).toMatch(/pnpm\s+(?:run\s+)?test/);
    });

    it("runs pnpm typecheck", () => {
      expect(
        content,
        ".github/workflows/ci.yml does not exist yet",
      ).not.toBe("");
      expect(
        content,
        "Expected workflow to contain a step that runs 'pnpm typecheck'",
      ).toMatch(/pnpm\s+(?:run\s+)?typecheck/);
    });

    it("runs pnpm build", () => {
      expect(
        content,
        ".github/workflows/ci.yml does not exist yet",
      ).not.toBe("");
      expect(
        content,
        "Expected workflow to contain a step that runs 'pnpm build'",
      ).toMatch(/pnpm\s+(?:run\s+)?build/);
    });
  });
});
