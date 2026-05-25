// Unit tests for isTutorialStale (issue #41).

import { describe, expect, it } from "vitest";

import { isTutorialStale } from "@/lib/vault/tutorial-staleness";

describe("isTutorialStale", () => {
  it("returns false for a fresh tutorial without mayBeStale", () => {
    const tutorial = {
      steps: [
        {
          order: 1,
          title: "Get your API key",
          body: "Log in to the dashboard and copy your API key.",
        },
      ],
      createdAt: new Date().toISOString(),
    };
    expect(isTutorialStale(tutorial)).toBe(false);
  });

  it("returns true when mayBeStale is true regardless of age", () => {
    const tutorial = {
      steps: [
        {
          order: 1,
          title: "Get your API key",
          body: "Log in to the dashboard and copy your API key.",
        },
      ],
      createdAt: new Date().toISOString(),
      mayBeStale: true,
    };
    expect(isTutorialStale(tutorial)).toBe(true);
  });

  it("returns true for a tutorial older than 90 days", () => {
    const ninetyOneDaysAgo = new Date();
    ninetyOneDaysAgo.setDate(ninetyOneDaysAgo.getDate() - 91);
    const tutorial = {
      steps: [
        {
          order: 1,
          title: "Get your API key",
          body: "Log in to the dashboard and copy your API key.",
        },
      ],
      createdAt: ninetyOneDaysAgo.toISOString(),
    };
    expect(isTutorialStale(tutorial)).toBe(true);
  });

  it("returns false for a tutorial exactly at 90 days (boundary: <=90 is not stale)", () => {
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const tutorial = {
      steps: [
        {
          order: 1,
          title: "Get your API key",
          body: "Log in to the dashboard and copy your API key.",
        },
      ],
      createdAt: ninetyDaysAgo.toISOString(),
    };
    expect(isTutorialStale(tutorial)).toBe(false);
  });
});
