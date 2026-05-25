/**
 * Tests for the tutorial step localStorage key pattern (Issue #64).
 *
 * Pure string logic tests — no DOM, no React. These tests verify the key
 * scheme that TutorialCard will use to persist step completion state in
 * localStorage, so the pattern is locked in before the component is built.
 */

import { describe, expect, it } from "vitest";

describe("tutorial localStorage key pattern", () => {
  function tutorialKey(secretId: string, stepOrder: number): string {
    return `sm:tutorial:${secretId}:step:${stepOrder}:done`;
  }

  it("builds correct key for secretId and step order", () => {
    expect(tutorialKey("abc123", 1)).toBe("sm:tutorial:abc123:step:1:done");
  });

  it("builds correct key for step order 0", () => {
    expect(tutorialKey("xyz", 0)).toBe("sm:tutorial:xyz:step:0:done");
  });

  it("key includes the secret id", () => {
    const key = tutorialKey("my-secret-id", 3);
    expect(key).toContain("my-secret-id");
  });

  it("key includes the step order", () => {
    const key = tutorialKey("sid", 7);
    expect(key).toContain(":step:7:");
  });
});
