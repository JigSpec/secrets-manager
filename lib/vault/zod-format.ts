import type { ZodError } from "zod";

/**
 * Format the first issue of a ZodError into a single human-readable string,
 * prefixed with the field path when one exists.
 *
 * Examples:
 *   path=["steps", 0, "body"]   → "steps[0].body: String must contain at least 1 character(s)"
 *   path=["createdAt"]          → "createdAt: Invalid datetime"
 *   path=[]                     → "Expected object, received string"          // no prefix
 *   path=["foo", 2, 3, "bar"]   → "foo[2][3].bar: <message>"                 // chained indices
 *
 * Behavior:
 *   - Builds the dotted/bracket path manually (Zod does not expose this helper).
 *   - String segments are joined with "." but the FIRST segment has no leading dot.
 *   - Numeric segments are rendered as "[N]" with NO leading dot before "[".
 *   - If path.length === 0, returns just `issue.message` (no prefix, no colon).
 *   - Always uses the FIRST issue (`error.issues[0]`); preserves current behavior of
 *     surfacing only one validation failure per call. Multi-issue surfacing is out of scope.
 *   - If `error.issues` is somehow empty (shouldn't happen for !success ZodErrors),
 *     return the string "bad shape" to match the current fallback.
 */
export function formatZodError(error: ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "bad shape";
  const path = issue.path;
  if (path.length === 0) return issue.message;

  let pretty = "";
  for (let i = 0; i < path.length; i++) {
    const seg = path[i];
    if (typeof seg === "number") {
      pretty += `[${seg}]`;
    } else {
      // string segment
      if (pretty.length === 0) pretty = String(seg);
      else pretty += `.${String(seg)}`;
    }
  }
  return `${pretty}: ${issue.message}`;
}
