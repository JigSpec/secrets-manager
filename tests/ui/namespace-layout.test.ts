/**
 * Issue #111 — Namespace UI/UX changes (static source-analysis tests).
 *
 * These tests use the same convention as the other tests/ui/* files: they
 * read the real component source files and assert the consumer contract that
 * the three UI changes require.  They are intentionally written to FAIL on
 * the current (pre-fix) code and to PASS once the fix is applied.
 *
 * Coverage:
 *   1. SecretDialog accepts a `defaultNamespace` prop and uses it when
 *      `initialSecret === null`.
 *   2. The namespace badge in secret-pane.tsx is NOT inside the inline key
 *      row span (`flex min-w-0 items-center gap-1.5`).
 *   3. The namespace badge in secret-pane.tsx IS placed below the
 *      value-dots line (after the isRevealed block).
 *   4. The namespace badge in repo-secrets-pane.tsx is inside a `flex-col`
 *      wrapper with the key span (not a bare sibling of the key span).
 *   5. repo-secrets-pane.tsx passes `defaultNamespace` to SecretDialog.
 *   6. Both namespace badges use smaller CSS classes (text-[9px] or similar)
 *      instead of the current `text-[10px]` class.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

// ---------------------------------------------------------------------------
// 1. components/secret-dialog.tsx — defaultNamespace prop
// ---------------------------------------------------------------------------
describe("components/secret-dialog.tsx — defaultNamespace prop (issue #111)", () => {
  const src = readSrc("components/secret-dialog.tsx");

  it("prop signature includes defaultNamespace?: string", () => {
    // The fix adds `defaultNamespace?: string` to the destructured props /
    // type annotation. Current code has no such prop at all.
    expect(src).toMatch(/defaultNamespace\?:\s*string/);
  });

  it("useEffect seeds namespace state from defaultNamespace when initialSecret is null", () => {
    // Before the fix the useEffect uses `initialSecret?.namespace ?? ""`
    // unconditionally, so a freshly opened "New secret" dialog never gets a
    // pre-filled namespace even when defaultNamespace is provided.
    //
    // After the fix the useEffect must branch on whether initialSecret is null
    // and, when it is, fall back to defaultNamespace.
    //
    // We detect this by asserting that `defaultNamespace` appears inside the
    // useEffect body.  The current code has no reference to defaultNamespace
    // anywhere in the file, so this test fails before the fix.
    const useEffectIdx = src.indexOf("useEffect(");
    expect(useEffectIdx).toBeGreaterThan(-1);
    // Capture a generous window covering the whole effect callback.
    const effectWindow = src.slice(useEffectIdx, useEffectIdx + 2000);
    expect(effectWindow).toMatch(/defaultNamespace/);
  });
});

// ---------------------------------------------------------------------------
// 2. components/secret-pane.tsx — namespace badge NOT in the inline key row
// ---------------------------------------------------------------------------
describe("components/secret-pane.tsx — namespace badge removed from inline key row (issue #111)", () => {
  const src = readSrc("components/secret-pane.tsx");

  it("namespace badge is NOT inside the flex min-w-0 items-center gap-1.5 key-row span", () => {
    // Current code: the namespace badge `{secret.namespace && (` is the very
    // first child inside `<span className="flex min-w-0 items-center gap-1.5">`.
    // After the fix it must be removed from that span so it no longer sits to
    // the left of the key name in the same horizontal row.
    //
    // We locate the key-row span and grab ~800 chars — enough to cover the
    // entire span (variant chip, awaiting chip, key text) without spilling into
    // the value-dots section below.  Then we assert the namespace conditional
    // is absent from that window.
    const keyRowIdx = src.indexOf("flex min-w-0 items-center gap-1.5");
    expect(keyRowIdx).toBeGreaterThan(-1);
    const keyRowWindow = src.slice(keyRowIdx, keyRowIdx + 800);
    expect(keyRowWindow).not.toMatch(/secret\.namespace\s*&&/);
  });
});

// ---------------------------------------------------------------------------
// 3. components/secret-pane.tsx — namespace badge IS below the value-dots line
// ---------------------------------------------------------------------------
describe("components/secret-pane.tsx — namespace badge appears below value-dots line (issue #111)", () => {
  const src = readSrc("components/secret-pane.tsx");

  it("namespace badge conditional appears after the isRevealed value-dots expression", () => {
    // After the fix the badge is a separate element rendered below the
    // value/dots line.  We verify ordering: the `isRevealed ? secret.value`
    // expression must appear at an earlier offset in the file than the
    // `secret.namespace &&` namespace badge conditional.
    //
    // Current code: `secret.namespace &&` appears ONLY inside the key row
    // span (before the value-dots line), so its index is LESS than that of
    // `isRevealed ? secret.value`.  This test therefore fails before the fix.
    const valuDotsIdx = src.indexOf("isRevealed ? secret.value");
    expect(valuDotsIdx).toBeGreaterThan(-1);

    // Search for the namespace badge occurrence that comes AFTER the value-dots
    // expression, rather than using lastIndexOf (which picks the last occurrence
    // regardless of context and would silently pick the wrong one if a second
    // namespace conditional is added elsewhere in the file).
    const afterValueDots = src.slice(valuDotsIdx);
    const relativeIdx = afterValueDots.indexOf("secret.namespace &&");
    // This assertion fails if no namespace badge exists after the value-dots
    // line, making the failure message unambiguous.
    expect(relativeIdx).toBeGreaterThan(-1);
    const namespaceBadgeIdx = valuDotsIdx + relativeIdx;

    // Key assertion: badge must come AFTER value-dots in source order.
    expect(namespaceBadgeIdx).toBeGreaterThan(valuDotsIdx);
  });
});

// ---------------------------------------------------------------------------
// 4. components/repo-secrets-pane.tsx — namespace badge inside flex-col wrapper
// ---------------------------------------------------------------------------
describe("components/repo-secrets-pane.tsx — namespace badge inside flex-col wrapper (issue #111)", () => {
  const src = readSrc("components/repo-secrets-pane.tsx");

  it("li row uses a flex-col wrapper to stack key name and namespace badge vertically", () => {
    // Current code: the <li> uses `flex items-center gap-2` at the top level;
    // the namespace badge is a *direct sibling* of the key span — there is no
    // flex-col wrapper.  After the fix a flex-col container must appear so
    // the badge renders below the key.
    //
    // We check for `flex-col` within a window around the list-item element
    // rather than scanning the whole file.  A file-wide match would pass even
    // if `flex-col` existed only in an unrelated part of the component.
    const listItemIdx = src.indexOf("key={secret.id}");
    expect(listItemIdx).toBeGreaterThan(-1);
    // Capture a ~1200-char window that covers the full <li> body.
    const listItemWindow = src.slice(listItemIdx, listItemIdx + 1200);
    expect(listItemWindow).toMatch(/flex-col/);
  });

  it("namespace badge conditional appears AFTER {secret.key} in the list-item template", () => {
    // Current code renders the namespace badge BEFORE the key span
    // (badge is the second child of <li> after the trash button, key span is third).
    // After the fix the badge renders AFTER / below the key span.
    //
    // We compare source-text indices: `{secret.key}` must appear before
    // `secret.namespace &&` in the post-fix code.  On the current code the
    // badge appears before {secret.key}, so this test fails.
    const keyIdx = src.indexOf("{secret.key}");
    expect(keyIdx).toBeGreaterThan(-1);

    const namespaceBadgeIdx = src.indexOf("secret.namespace &&");
    expect(namespaceBadgeIdx).toBeGreaterThan(-1);

    // Badge must come AFTER the key text in source order.
    expect(namespaceBadgeIdx).toBeGreaterThan(keyIdx);
  });
});

// ---------------------------------------------------------------------------
// 5. components/repo-secrets-pane.tsx — SecretDialog receives defaultNamespace
// ---------------------------------------------------------------------------
describe("components/repo-secrets-pane.tsx — SecretDialog receives defaultNamespace (issue #111)", () => {
  const src = readSrc("components/repo-secrets-pane.tsx");

  it("SecretDialog usage passes a defaultNamespace prop", () => {
    // Current code: the <SecretDialog> in repo-secrets-pane.tsx has no
    // defaultNamespace prop.  After the fix it must supply one so that the
    // "New secret" dialog can pre-fill the namespace field for the repo context.
    const dialogIdx = src.indexOf("<SecretDialog");
    expect(dialogIdx).toBeGreaterThan(-1);
    // Capture enough of the JSX element to see all its props.
    const dialogWindow = src.slice(dialogIdx, dialogIdx + 600);
    expect(dialogWindow).toMatch(/defaultNamespace/);
  });
});

// ---------------------------------------------------------------------------
// 6. Visually smaller namespace badge — both files
// ---------------------------------------------------------------------------
describe("namespace badge uses smaller text class in both panes (issue #111)", () => {
  it("secret-pane.tsx: namespace badge does NOT use text-[10px] (replaced by smaller class)", () => {
    const src = readSrc("components/secret-pane.tsx");
    // Current className on the namespace badge includes `text-[10px]`.
    // After the fix it must use a smaller class (e.g. text-[9px] or text-[8px]).
    // We locate the badge by its tooltip title and then look at a window
    // around it for the text-size class.
    const badgeIdx = src.indexOf("namespace: ${secret.namespace}");
    expect(badgeIdx).toBeGreaterThan(-1);
    // Grab 400 chars before the title string to capture the full className.
    const badgeWindow = src.slice(Math.max(0, badgeIdx - 400), badgeIdx + 50);
    // Must NOT still have the old text-[10px].
    expect(badgeWindow).not.toMatch(/text-\[10px\]/);
  });

  it("repo-secrets-pane.tsx: namespace badge does NOT use text-[10px] (replaced by smaller class)", () => {
    const src = readSrc("components/repo-secrets-pane.tsx");
    const badgeIdx = src.indexOf("namespace: ${secret.namespace}");
    expect(badgeIdx).toBeGreaterThan(-1);
    const badgeWindow = src.slice(Math.max(0, badgeIdx - 400), badgeIdx + 50);
    expect(badgeWindow).not.toMatch(/text-\[10px\]/);
  });
});
