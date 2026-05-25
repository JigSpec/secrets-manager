// Unit tests for the formatZodError helper (lib/vault/zod-format.ts).

import { describe, expect, it } from "vitest";
import { ZodError, type ZodIssue } from "zod";
import { formatZodError } from "@/lib/vault/zod-format";

// ---------------------------------------------------------------------------
// Helpers to build minimal ZodIssue objects
// ---------------------------------------------------------------------------

function makeIssue(
  path: (string | number)[],
  message: string,
): ZodIssue {
  return {
    code: "custom",
    path,
    message,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("formatZodError", () => {
  it('formats path=["steps", 0, "body"] correctly', () => {
    const err = new ZodError([
      makeIssue(["steps", 0, "body"], "String must contain at least 1 character(s)"),
    ]);
    expect(formatZodError(err)).toBe(
      "steps[0].body: String must contain at least 1 character(s)",
    );
  });

  it('formats path=["createdAt"] (single string segment) correctly', () => {
    const err = new ZodError([makeIssue(["createdAt"], "Invalid datetime")]);
    expect(formatZodError(err)).toBe("createdAt: Invalid datetime");
  });

  it("formats path=[] (empty path) as just the message with no prefix", () => {
    const err = new ZodError([
      makeIssue([], "Expected object, received string"),
    ]);
    expect(formatZodError(err)).toBe("Expected object, received string");
  });

  it('formats path=["foo", 2, 3, "bar"] with chained numeric indices', () => {
    const err = new ZodError([
      makeIssue(["foo", 2, 3, "bar"], "some error message"),
    ]);
    expect(formatZodError(err)).toBe("foo[2][3].bar: some error message");
  });

  it("returns 'bad shape' when error.issues is empty", () => {
    // Bypass ZodError's internal validation by casting.
    const err = new ZodError([]) as ZodError;
    expect(formatZodError(err)).toBe("bad shape");
  });

  it("formats all-numeric root path=[0, \"field\"] correctly", () => {
    const err = new ZodError([makeIssue([0, "field"], "Required")]);
    expect(formatZodError(err)).toBe("[0].field: Required");
  });
});
