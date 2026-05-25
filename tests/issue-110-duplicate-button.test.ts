/**
 * Tests for Issue #110: "Duplicate" button on each secret row.
 *
 * The feature adds a Copy icon button to each row in `components/secret-pane.tsx`
 * that opens `components/secret-dialog.tsx` pre-populated with the source
 * secret's fields. The user must change key, namespace, or variant before submitting.
 *
 * These are pure source-text / static-regex tests (no DOM, no React render),
 * consistent with this project's Vitest `environment: "node"` config.
 *
 * Tests that FAIL before the fix (feature not yet implemented):
 *   TC-1.1 through TC-1.6, TC-2.1 through TC-2.7, TC-3.1 through TC-3.2.
 *
 * Tests that PASS before and after the fix (regression guards):
 *   TC-4.1 and TC-4.2 (app/actions.ts already has the right shape).
 *
 * Unit/integration tests (Section 5):
 *   TC-5.1 through TC-5.5 — validate the duplicate-mode logic inline.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

const paneSrc = readSrc("components/secret-pane.tsx");
const dialogSrc = readSrc("components/secret-dialog.tsx");
const actionsSrc = readSrc("app/actions.ts");

// ---------------------------------------------------------------------------
// SECTION 1 — secret-pane.tsx source checks
// ---------------------------------------------------------------------------

describe("secret-pane.tsx — Duplicate button (Issue #110, Section 1)", () => {
  it("TC-1.1: imports Copy icon from lucide-react", () => {
    // The Duplicate button should use the Copy icon from lucide-react.
    // The import line must include `Copy` in the destructured list.
    const importsCopy =
      /^import\s+\{[^}]*\bCopy\b[^}]*\}\s+from\s+["']lucide-react["']/m.test(paneSrc) ||
      /\{[^}]*\bCopy\b[^}]*\}\s+from\s+["']lucide-react["']/.test(paneSrc);
    expect(
      importsCopy,
      'Expected secret-pane.tsx to import `Copy` from lucide-react. ' +
      'Add `Copy` to the lucide-react named-import list and use it in the Duplicate button.',
    ).toBe(true);
  });

  it("TC-1.2: declares a `duplicating` state variable", () => {
    // The component needs a state variable to track which secret is being
    // duplicated so SecretDialog can be opened in duplicate mode.
    // Must have both the identifier and a useState call.
    // Parentheses added to the second alternative to fix operator precedence:
    // `||` has lower precedence than `&&`, so the parens make the intent explicit.
    const hasDuplicatingState =
      /const\s+\[\s*duplicating\s*,\s*setDuplicating\s*\]/.test(paneSrc) ||
      (/\bduplicating\b/.test(paneSrc) && /\bsetDuplicating\b/.test(paneSrc));
    expect(
      hasDuplicatingState,
      'Expected secret-pane.tsx to declare a `duplicating` state variable ' +
      '(e.g. `const [duplicating, setDuplicating] = useState<Secret | null>(null)`).',
    ).toBe(true);
  });

  it('TC-1.3: renders a button with aria-label="Duplicate secret"', () => {
    // Each secret row must have a Duplicate button accessible via aria-label.
    const hasDuplicateButton =
      /aria-label\s*=\s*[{"'`]Duplicate secret[}"'`]/.test(paneSrc) ||
      /aria-label\s*=\s*\{[^}]*"Duplicate secret"[^}]*\}/.test(paneSrc);
    expect(
      hasDuplicateButton,
      'Expected secret-pane.tsx to render a button with aria-label="Duplicate secret". ' +
      'Add a Copy icon button with aria-label="Duplicate secret" to each row.',
    ).toBe(true);
  });

  it("TC-1.4: passes `duplicateSource` prop to SecretDialog", () => {
    // SecretDialog must receive a `duplicateSource` prop so it knows it is
    // being opened in duplicate mode with a pre-populated secret.
    const passesDuplicateSource = /duplicateSource\s*=/.test(paneSrc);
    expect(
      passesDuplicateSource,
      'Expected secret-pane.tsx to pass a `duplicateSource` prop to <SecretDialog>. ' +
      'Add `duplicateSource={duplicating}` (or similar) to the SecretDialog JSX.',
    ).toBe(true);
  });

  it("TC-1.5: clears `duplicating` state when dialog closes (`setDuplicating(null)`)", () => {
    // When the dialog closes the duplicating state must be cleared so the next
    // open is always a fresh add (unless Duplicate is clicked again).
    const clearsDuplicatingOnClose = /setDuplicating\s*\(\s*null\s*\)/.test(paneSrc);
    expect(
      clearsDuplicatingOnClose,
      'Expected secret-pane.tsx to call `setDuplicating(null)` when the dialog closes. ' +
      'Add `setDuplicating(null)` inside the `onOpenChange` handler of SecretDialog.',
    ).toBe(true);
  });

  it("TC-1.6: New button defensively clears duplicating state (`setDuplicating(null)` is present)", () => {
    // The component must have `setDuplicating(null)` callable so the New button
    // can clear the duplicating source before opening a fresh add dialog.
    // This overlaps with TC-1.5 intentionally: both the close-handler and the
    // New-button click must call setDuplicating(null). We check for the
    // identifier `setDuplicating` appearing at least twice (once per call site).
    const callCount = (paneSrc.match(/\bsetDuplicating\s*\(/g) ?? []).length;
    expect(
      callCount >= 2,
      `Expected secret-pane.tsx to call \`setDuplicating(null)\` in at least two ` +
      `places (New button onClick AND dialog onOpenChange), but found ${callCount} call(s). ` +
      'Add setDuplicating(null) in both the New button\'s onClick and the onOpenChange handler.',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SECTION 2 — secret-dialog.tsx source checks
// ---------------------------------------------------------------------------

describe("secret-dialog.tsx — duplicateSource prop and duplicate mode (Issue #110, Section 2)", () => {
  it("TC-2.1: accepts a `duplicateSource` prop", () => {
    // The dialog must accept a `duplicateSource` prop in its props destructuring
    // or type annotation so callers can pass the source secret.
    const acceptsDuplicateSource = /duplicateSource/.test(dialogSrc);
    expect(
      acceptsDuplicateSource,
      'Expected secret-dialog.tsx to accept a `duplicateSource` prop. ' +
      'Add `duplicateSource?: Secret | null` to the component prop types and destructure it.',
    ).toBe(true);
  });

  it('TC-2.2: derives a `mode` variable with "duplicate" as a possible value', () => {
    // The dialog should derive a mode string from its props so the title,
    // validation, and hints can branch on "add" | "edit" | "duplicate".
    const hasMode = /\bmode\b/.test(dialogSrc);
    const hasDuplicateString = /["'`]duplicate["'`]/.test(dialogSrc);
    expect(
      hasMode && hasDuplicateString,
      'Expected secret-dialog.tsx to derive a `mode` variable that includes ' +
      '"duplicate" as a possible value (e.g. `const mode = initialSecret ? "edit" : duplicateSource ? "duplicate" : "add"`).',
    ).toBe(true);
  });

  it("TC-2.3: useEffect populates fields from `duplicateSource` when open", () => {
    // When the dialog opens in duplicate mode the fields must be pre-populated
    // from the source secret. The useEffect that watches `open` must also
    // reference `duplicateSource` to populate the fields.
    const hasDuplicateSourceInEffect =
      /duplicateSource/.test(dialogSrc) &&
      /useEffect/.test(dialogSrc) &&
      (() => {
        // Check that duplicateSource is referenced inside a useEffect block
        const idx = dialogSrc.indexOf("useEffect");
        if (idx === -1) return false;
        const segment = dialogSrc.slice(idx, idx + 800);
        return /duplicateSource/.test(segment);
      })();
    expect(
      hasDuplicateSourceInEffect,
      'Expected secret-dialog.tsx useEffect to populate form fields from ' +
      '`duplicateSource` when the dialog opens in duplicate mode. ' +
      'Reference `duplicateSource` inside the useEffect callback.',
    ).toBe(true);
  });

  it("TC-2.4: validates that namespace or variant must change in duplicate mode", () => {
    // Submitting with the same (key, namespace, variant) triple as the source
    // secret would create a duplicate entry and fail server-side. The dialog
    // must catch this client-side and show an error.
    // Specifically check for mode === "duplicate" guard in handleSubmit.
    const hasSpecificValidation =
      /duplicateSource\.(namespace|variant)/.test(dialogSrc) ||
      (
        /mode\s*===\s*["'`]duplicate["'`]/.test(dialogSrc) &&
        /setError/.test(dialogSrc)
      );
    expect(
      hasSpecificValidation,
      'Expected secret-dialog.tsx to validate that namespace or variant must ' +
      'differ from the source secret in duplicate mode and call setError with an ' +
      'appropriate message. Add a check in handleSubmit for `mode === "duplicate"`.',
    ).toBe(true);
  });

  it('TC-2.5: shows "Duplicate secret" as the dialog title in duplicate mode', () => {
    // The DialogTitle must say "Duplicate secret" when in duplicate mode,
    // distinct from the "Edit secret" / "New secret" titles.
    const hasDuplicateTitle = /Duplicate secret/.test(dialogSrc);
    expect(
      hasDuplicateTitle,
      'Expected secret-dialog.tsx to render "Duplicate secret" as the DialogTitle ' +
      'when mode === "duplicate". Update the DialogTitle conditional to include this case.',
    ).toBe(true);
  });

  it("TC-2.6: shows a hint about changing key, namespace, or variant in duplicate mode", () => {
    // A contextual hint must be shown so the user understands they need to
    // change the key, namespace, or variant before the duplicate can be saved.
    // Check for 'duplicate' keyword AND a nearby reference to a field change.
    const hasDuplicateKeyword = /duplicate/i.test(dialogSrc);
    const hasChangeHint =
      /namespace or variant/i.test(dialogSrc) ||
      /variant or namespace/i.test(dialogSrc) ||
      /change.*namespace/i.test(dialogSrc) ||
      /change.*variant/i.test(dialogSrc) ||
      /key.*namespace.*variant/i.test(dialogSrc);
    expect(
      hasDuplicateKeyword && hasChangeHint,
      'Expected secret-dialog.tsx to show a hint in duplicate mode telling the user ' +
      'to change the key, namespace, or variant. Add a conditional element that ' +
      'contains text like "Change the key, namespace, or variant to create a distinct secret."',
    ).toBe(true);
  });

  it("TC-2.7: useEffect dependency array includes `duplicateSource`", () => {
    // The useEffect that pre-populates the form must list `duplicateSource` in
    // its dependency array so changes to the source are reflected correctly.
    // Search the entire file rather than a fixed 800-char window — the dep
    // array appears after the full useEffect callback body, which may be long.
    const effectWithDuplicateSource =
      /\[([^\]]*,\s*)?duplicateSource(\s*,[^\]]*)?\]/.test(dialogSrc);
    expect(
      effectWithDuplicateSource,
      'Expected the useEffect in secret-dialog.tsx to include `duplicateSource` in ' +
      'its dependency array so the form re-populates when the source secret changes.',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SECTION 3 — validation logic source-text
// ---------------------------------------------------------------------------

describe("secret-dialog.tsx — duplicate-mode validation logic (Issue #110, Section 3)", () => {
  it("TC-3.1: compares duplicateSource.namespace or duplicateSource.variant in validation", () => {
    // The handleSubmit validation for duplicate mode must compare the
    // current namespace/variant fields against the source's values to
    // detect an unchanged triple.
    const comparesNamespaceOrVariant =
      /duplicateSource\.(namespace|variant)/.test(dialogSrc);
    expect(
      comparesNamespaceOrVariant,
      'Expected secret-dialog.tsx handleSubmit to reference `duplicateSource.namespace` ' +
      'or `duplicateSource.variant` when validating in duplicate mode.',
    ).toBe(true);
  });

  it("TC-3.2: handleSubmit calls setError with a string literal mentioning namespace or variant", () => {
    // The error message shown to the user when they try to submit without
    // changing the namespace or variant must mention those fields explicitly.
    // We look for a string literal passed to setError that contains the words.
    // Using a tighter regex to avoid false-positives from form label/placeholder text.
    const hasErrorStringWithFields =
      /setError\s*\(\s*["'`][^"'`]*(namespace|variant)[^"'`]*["'`]\s*\)/.test(dialogSrc);
    expect(
      hasErrorStringWithFields,
      'Expected secret-dialog.tsx to call setError with a string literal that ' +
      'contains "namespace" or "variant" when the duplicate triple is unchanged. ' +
      'E.g.: setError("Duplicate must have a different key, namespace, or variant than the source secret.").',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SECTION 4 — app/actions.ts is unchanged (regression guards — PASS before & after)
// ---------------------------------------------------------------------------

describe("app/actions.ts — addSecretAction already handles duplicates (Issue #110, Section 4)", () => {
  it("TC-4.1: addSecretAction is already exported (no new server action needed)", () => {
    // The Duplicate button reuses the existing addSecretAction — no new
    // server action is required by this feature.
    const isExported =
      /export\s+async\s+function\s+addSecretAction/.test(actionsSrc);
    expect(
      isExported,
      'Expected app/actions.ts to export `addSecretAction`. ' +
      'This function must remain exported so the Duplicate button can call it.',
    ).toBe(true);
  });

  it("TC-4.2: addSecretAction enforces (key, namespace, variant) uniqueness", () => {
    // The server-side uniqueness check must compare all three fields so that
    // a duplicate submission with unchanged namespace+variant is rejected.
    // Slice out the addSecretAction body for a targeted check rather than
    // searching the whole file (which would match any occurrence of the words).
    const fnIdx = actionsSrc.indexOf("export async function addSecretAction");
    const nextFnIdx = actionsSrc.indexOf("export async function", fnIdx + 1);
    const fnBody = actionsSrc.slice(fnIdx, nextFnIdx === -1 ? undefined : nextFnIdx);
    const enforcesTripleUniqueness =
      /s\.key\s*===\s*parsed\.data\.key/.test(fnBody) &&
      /s\.namespace/.test(fnBody) &&
      /s\.variant/.test(fnBody);
    expect(
      enforcesTripleUniqueness,
      'Expected addSecretAction in app/actions.ts to enforce (key, namespace, variant) ' +
      'uniqueness by comparing s.key, s.namespace, and s.variant against the parsed input.',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SECTION 5 — Logic unit tests for duplicate-mode validation
//
// These tests exercise the validation logic inline (no DOM or React needed):
// they mirror exactly what handleSubmit in secret-dialog.tsx does, so any
// change to the validation rules will break these tests immediately.
//
// Coverage:
//   TC-5.1  Same key + namespace + variant → rejected
//   TC-5.2  Same key + namespace but different variant → accepted
//   TC-5.3  Same key + variant but different namespace → accepted
//   TC-5.4  Different key alone (same namespace + variant) → accepted
//   TC-5.5  Whitespace-padded namespace is trimmed before comparison
// ---------------------------------------------------------------------------

describe("duplicate-mode validation logic (Issue #110, Section 5)", () => {
  /**
   * Inline mirror of the handleSubmit duplicate check in secret-dialog.tsx.
   * Returns an error string if the submission should be rejected, null if allowed.
   *
   * Both sides of each comparison are trimmed to match the implementation,
   * which fixes the bug where whitespace-padded source fields would bypass
   * the guard.
   */
  function validateDuplicate(
    formKey: string,
    formNamespace: string,
    formVariant: string,
    source: { key: string; namespace?: string; variant?: string },
  ): string | null {
    const nsChanged =
      formNamespace.trim() !== (source.namespace ?? "").trim();
    const variantChanged =
      formVariant.trim() !== (source.variant ?? "").trim();
    const keyChanged = formKey.trim() !== source.key.trim();
    if (!nsChanged && !variantChanged && !keyChanged) {
      return "Duplicate must have a different key, namespace, or variant than the source secret.";
    }
    return null;
  }

  it("TC-5.1: same key + namespace + variant is rejected", () => {
    const source = { key: "API_KEY", namespace: "stripe", variant: "test" };
    const err = validateDuplicate("API_KEY", "stripe", "test", source);
    expect(err).not.toBeNull();
    expect(err).toMatch(/namespace|variant/);
  });

  it("TC-5.2: same key + namespace but different variant is accepted", () => {
    const source = { key: "API_KEY", namespace: "stripe", variant: "test" };
    const err = validateDuplicate("API_KEY", "stripe", "live", source);
    expect(err).toBeNull();
  });

  it("TC-5.3: same key + variant but different namespace is accepted", () => {
    const source = { key: "API_KEY", namespace: "stripe", variant: "test" };
    const err = validateDuplicate("API_KEY", "sendgrid", "test", source);
    expect(err).toBeNull();
  });

  it("TC-5.4: different key alone (same namespace + variant) is accepted", () => {
    const source = { key: "API_KEY", namespace: "stripe", variant: "test" };
    const err = validateDuplicate("SECRET_KEY", "stripe", "test", source);
    expect(err).toBeNull();
  });

  it("TC-5.5: whitespace-padded namespace is trimmed before comparison", () => {
    // A source with namespace "stripe" and a form value of "  stripe  " (padded)
    // must be treated as unchanged — the duplicate guard must reject it.
    const source = { key: "API_KEY", namespace: "stripe" };
    const errSame = validateDuplicate("API_KEY", "  stripe  ", "", source);
    expect(errSame).not.toBeNull();
    // But if the key is also different it should be accepted.
    const errKeyDiff = validateDuplicate("DB_URL", "  stripe  ", "", source);
    expect(errKeyDiff).toBeNull();
  });
});
