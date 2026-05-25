/**
 * Regression tests for issue #69 follow-up: the dialog's right-aligned
 * position counter ("X of N") must not overlap the Radix close button that
 * `DialogContent` absolutely positions at `right-4 top-4`.
 *
 * The project's vitest environment is "node" — there is no DOM — so these
 * assertions operate on the component source at the className level, which
 * is where Tailwind expresses layout intent.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DIALOG_SRC = readFileSync(
  join(process.cwd(), "components/needs-attention-dialog.tsx"),
  "utf-8",
);

const UI_DIALOG_SRC = readFileSync(
  join(process.cwd(), "components/ui/dialog.tsx"),
  "utf-8",
);

describe("NeedsAttentionDialog header layout", () => {
  it("position counter is rendered inside the DialogHeader", () => {
    expect(DIALOG_SRC).toMatch(
      /<DialogHeader\b[\s\S]*?\{safeIndex \+ 1\}[\s\S]*?of[\s\S]*?\{liveSessionList\.length\}[\s\S]*?<\/DialogHeader>/,
    );
  });

  it("DialogContent's close button sits at right-4 (the constraint that drives header padding)", () => {
    // This is a pinning assertion against the shadcn dialog primitive: if the
    // close button ever moves, the padding requirement below should be
    // revisited. Keeping the two assertions together makes the rationale
    // self-documenting.
    expect(UI_DIALOG_SRC).toMatch(
      /DialogPrimitive\.Close[\s\S]*?className=["'`][^"'`]*\bright-4\b[\s\S]*?top-4\b/,
    );
  });

  it("header reserves right padding so right-aligned content clears the close X", () => {
    // The close button is `h-4 w-4` at `right-4 top-4`, occupying pixels
    // 16-32 from the dialog's right edge. The header that hosts the counter
    // must reserve ≥ 40px (pr-10) of right padding so end-aligned children
    // clear that hit area.
    //
    // We target the *className-bearing* DialogHeader (the carousel header).
    // The bare `<DialogHeader>` used in the empty-state branch has no
    // right-aligned content so the constraint doesn't apply there.
    const headerOpen = DIALOG_SRC.match(
      /<DialogHeader\s+className=["'][^"']*["']\s*>/,
    );
    expect(
      headerOpen,
      "DialogHeader with className must exist",
    ).toBeTruthy();
    const tag = headerOpen![0];

    // `px-6` only gives 24px on the right — collides with the close button.
    expect(
      tag,
      "DialogHeader must not use px-6 — collides with the absolute close X at right-4",
    ).not.toMatch(/\bpx-6\b/);

    // Right padding must be ≥ pr-10 (40px). Tailwind values 10, 11, 12, 14,
    // 16, 20 all satisfy the constraint.
    expect(
      tag,
      "DialogHeader must reserve ≥ pr-10 of right padding to clear the close X",
    ).toMatch(/\bpr-(?:10|11|12|14|16|20)\b/);
  });
});
