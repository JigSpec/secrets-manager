// Zod validation tests for TutorialSchema and Tutorial type (issue #41).

import { describe, expect, it } from "vitest";

import { TutorialSchema } from "@/lib/vault/schema";

/** A minimal valid tutorial — used as a baseline across tests. */
function validTutorial() {
  return {
    steps: [
      {
        order: 1,
        title: "Log in to the dashboard",
        body: "Navigate to https://example.com and sign in with your credentials.",
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

describe("TutorialSchema", () => {
  // ── happy-path ────────────────────────────────────────────────────────────

  it("valid tutorial with all required fields passes", () => {
    const result = TutorialSchema.safeParse(validTutorial());
    expect(result.success).toBe(true);
  });

  it("valid tutorial with all optional fields passes", () => {
    const tut = {
      ...validTutorial(),
      mayBeStale: false,
      authorAgent: "claude-opus-4",
    };
    const result = TutorialSchema.safeParse(tut);
    expect(result.success).toBe(true);
  });

  it("mayBeStale is optional — absent is fine", () => {
    const tut = validTutorial();
    // Ensure mayBeStale is not present.
    expect(Object.prototype.hasOwnProperty.call(tut, "mayBeStale")).toBe(
      false,
    );
    const result = TutorialSchema.safeParse(tut);
    expect(result.success).toBe(true);
  });

  it("valid link URL on a step passes", () => {
    const tut = {
      ...validTutorial(),
      steps: [
        {
          order: 1,
          title: "Open the console",
          body: "Navigate to the AWS console.",
          link: "https://console.aws.amazon.com/",
        },
      ],
    };
    const result = TutorialSchema.safeParse(tut);
    expect(result.success).toBe(true);
  });

  it("createdAt must be an ISO-8601 datetime string", () => {
    const good = TutorialSchema.safeParse({
      ...validTutorial(),
      createdAt: "2025-01-15T12:00:00.000Z",
    });
    expect(good.success).toBe(true);
  });

  // ── error paths ───────────────────────────────────────────────────────────

  it("missing steps field fails", () => {
    const { steps: _steps, ...noSteps } = validTutorial() as Record<
      string,
      unknown
    >;
    const result = TutorialSchema.safeParse(noSteps);
    expect(result.success).toBe(false);
  });

  it("empty steps array fails (min 1)", () => {
    const result = TutorialSchema.safeParse({
      ...validTutorial(),
      steps: [],
    });
    expect(result.success).toBe(false);
  });

  it("step.body over 2000 chars fails", () => {
    const result = TutorialSchema.safeParse({
      ...validTutorial(),
      steps: [
        {
          order: 1,
          title: "A title",
          body: "B".repeat(2001),
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("step.body exactly 2000 chars passes", () => {
    const result = TutorialSchema.safeParse({
      ...validTutorial(),
      steps: [
        {
          order: 1,
          title: "A title",
          body: "B".repeat(2000),
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("invalid link URL (not a URL) fails", () => {
    const result = TutorialSchema.safeParse({
      ...validTutorial(),
      steps: [
        {
          order: 1,
          title: "Open the console",
          body: "Do something.",
          link: "not-a-url",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("createdAt with a non-datetime string fails", () => {
    const result = TutorialSchema.safeParse({
      ...validTutorial(),
      createdAt: "yesterday",
    });
    expect(result.success).toBe(false);
  });

  it("missing createdAt fails", () => {
    const tut = validTutorial() as Record<string, unknown>;
    delete tut.createdAt;
    const result = TutorialSchema.safeParse(tut);
    expect(result.success).toBe(false);
  });

  it("step missing title fails", () => {
    const result = TutorialSchema.safeParse({
      ...validTutorial(),
      steps: [
        {
          order: 1,
          body: "Body without a title.",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("step missing body fails", () => {
    const result = TutorialSchema.safeParse({
      ...validTutorial(),
      steps: [
        {
          order: 1,
          title: "Title without a body.",
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("step missing order fails", () => {
    const result = TutorialSchema.safeParse({
      ...validTutorial(),
      steps: [
        {
          title: "Title",
          body: "Body text.",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});
