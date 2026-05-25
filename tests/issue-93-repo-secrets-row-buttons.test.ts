/**
 * Test 1 — Issue #93 Point 2: RepoSecretsPane row action buttons
 *
 * Verifies that each secret row in `components/repo-secrets-pane.tsx` renders:
 *   - an Eye button   aria-label="Reveal value"
 *   - a Pencil button aria-label="Edit secret"
 *   - a Trash2 button aria-label="Delete secret"
 *
 * These are pure source-text tests (no DOM/React) consistent with
 * this project's Vitest `environment: "node"` config.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

const src = readSrc("components/repo-secrets-pane.tsx");

describe("repo-secrets-pane.tsx — row action buttons (Issue #93, Point 2)", () => {
  it('renders a button with aria-label "Reveal value" on each secret row', () => {
    // The Eye icon button that lets the user reveal the secret value inline.
    // Accept both a static aria-label="Reveal value" and a dynamic ternary form
    // such as aria-label={condition ? "Hide value" : "Reveal value"}.
    const hasRevealButton =
      /aria-label\s*=\s*[{"'`]Reveal value[}"'`]/.test(src) ||
      /aria-label\s*=\s*\{[^}]*"Reveal value"[^}]*\}/.test(src);
    expect(
      hasRevealButton,
      'Expected an aria-label="Reveal value" button in repo-secrets-pane.tsx but none was found. '
      + 'Add an Eye icon button to each secret row.',
    ).toBe(true);
  });

  it('renders a button with aria-label "Edit secret" on each secret row', () => {
    // The Pencil icon button that opens the edit dialog for the secret.
    const hasEditButton = /aria-label\s*=\s*[{"'`]Edit secret[}"'`]/.test(src);
    expect(
      hasEditButton,
      'Expected an aria-label="Edit secret" button in repo-secrets-pane.tsx but none was found. '
      + 'Add a Pencil icon button to each secret row.',
    ).toBe(true);
  });

  it('renders a button with aria-label "Delete secret" on each secret row', () => {
    // A distinct "Delete secret" button (separate from the unscope button).
    const hasDeleteButton = /aria-label\s*=\s*[{"'`]Delete secret[}"'`]/.test(src);
    expect(
      hasDeleteButton,
      'Expected an aria-label="Delete secret" button in repo-secrets-pane.tsx but none was found. '
      + 'Add a Trash2 icon button (Delete secret) to each secret row.',
    ).toBe(true);
  });

  it('imports the Eye icon from lucide-react for the reveal button', () => {
    const importsEye = /\bEye\b/.test(src);
    expect(
      importsEye,
      'Expected "Eye" to be imported from lucide-react in repo-secrets-pane.tsx. '
      + 'Import Eye and use it in the Reveal value button.',
    ).toBe(true);
  });

  it('imports the Pencil icon from lucide-react for the edit button', () => {
    const importsPencil = /\bPencil\b/.test(src);
    expect(
      importsPencil,
      'Expected "Pencil" to be imported from lucide-react in repo-secrets-pane.tsx. '
      + 'Import Pencil and use it in the Edit secret button.',
    ).toBe(true);
  });
});
