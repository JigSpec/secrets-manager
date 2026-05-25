/**
 * Phase 3 — Web UI variant exposure (static source-analysis tests).
 *
 * Mirrors the convention of the other tests/ui/* files: rather than rendering
 * server components in a fake Next.js runtime, we read source files and assert
 * the consumer contract the variant feature requires.
 *
 * Coverage:
 *   1. app/actions.ts exports the three env-variant server actions and the
 *      SecretInputSchema accepts a `variant` field.
 *   2. addSecretAction calls planAutoScope so GUI-created variant-bearing
 *      secrets get auto-scoped (matching CLI/MCP parity).
 *   3. components/secret-dialog.tsx renders a `secret-variant` input.
 *   4. components/secret-pane.tsx renders a variant chip with a tooltip
 *      mentioning "variant:".
 *   5. components/env-variant-dialog.tsx exists, exports EnvVariantDialog,
 *      loads via envVariantListAction, mutates via the set/unset actions,
 *      and offers a "Restore defaults" button (NOT "Disable").
 *   6. components/topbar.tsx mounts EnvVariantDialog and passes `repos` to it.
 *
 * Tests are intentionally lightweight — they encode the consumer contract,
 * not implementation details.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

// ---------------------------------------------------------------------------
// 1. app/actions.ts — variant on secret CRUD + env-variant actions
// ---------------------------------------------------------------------------
describe("app/actions.ts — variant exposure", () => {
  const src = readSrc("app/actions.ts");

  it("SecretInputSchema includes a variant field bound to VariantSchema", () => {
    expect(src).toMatch(/VariantSchema/);
    expect(src).toMatch(/variant:\s*VariantSchema\.optional\(\)/);
  });

  it("addSecretAction calls planAutoScope when variant is set", () => {
    const fnIdx = src.indexOf("export async function addSecretAction");
    expect(fnIdx).toBeGreaterThan(-1);
    // Slice from the function start to the next top-level export.
    const next = src.indexOf("export async function", fnIdx + 1);
    const body = src.slice(fnIdx, next === -1 ? undefined : next);
    expect(body).toMatch(/planAutoScope/);
    expect(body).toMatch(/applyAutoScope/);
  });

  it("identity rule checks the (key, namespace, variant) triple in addSecretAction", () => {
    const fnIdx = src.indexOf("export async function addSecretAction");
    const next = src.indexOf("export async function", fnIdx + 1);
    const body = src.slice(fnIdx, next === -1 ? undefined : next);
    // The duplicate-check must compare variant as well.
    expect(body).toMatch(/s\.variant/);
  });

  it("updateSecretAction accepts and forwards variant", () => {
    const fnIdx = src.indexOf("export async function updateSecretAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const next = src.indexOf("export async function", fnIdx + 1);
    const body = src.slice(fnIdx, next === -1 ? undefined : next);
    expect(body).toMatch(/variant\?:\s*string/);
    expect(body).toMatch(/parsed\.data\.variant/);
    // It must update OR delete the field based on whether variant was provided.
    expect(body).toMatch(/updated\.variant/);
    expect(body).toMatch(/delete updated\.variant/);
  });

  // -------------------------------------------------------------------------
  // Phase 4 — Task 9: updateSecretAction re-runs auto-scope when variant set
  // -------------------------------------------------------------------------
  it("updateSecretAction re-runs planAutoScope/applyAutoScope when variant is set", () => {
    const fnIdx = src.indexOf("export async function updateSecretAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const next = src.indexOf("export async function", fnIdx + 1);
    const body = src.slice(fnIdx, next === -1 ? undefined : next);
    // Mirror addSecretAction's call signature.
    expect(body).toMatch(/planAutoScope/);
    expect(body).toMatch(/applyAutoScope/);
  });

  it("updateSecretAction returns a skippedVariants array on success", () => {
    const fnIdx = src.indexOf("export async function updateSecretAction");
    const next = src.indexOf("export async function", fnIdx + 1);
    const body = src.slice(fnIdx, next === -1 ? undefined : next);
    expect(body).toMatch(/skippedVariants/);
  });

  it("addSecretAction returns a skippedVariants array on success", () => {
    const fnIdx = src.indexOf("export async function addSecretAction");
    const next = src.indexOf("export async function", fnIdx + 1);
    const body = src.slice(fnIdx, next === -1 ? undefined : next);
    expect(body).toMatch(/skippedVariants/);
  });

  it("exports envVariantListAction", () => {
    const hasExport =
      /export\s+(?:async\s+)?function\s+envVariantListAction\b/.test(src) ||
      /export\s*\{[^}]*\benvVariantListAction\b[^}]*\}/.test(src);
    expect(hasExport).toBe(true);
  });

  it("exports envVariantSetAction", () => {
    const hasExport =
      /export\s+(?:async\s+)?function\s+envVariantSetAction\b/.test(src) ||
      /export\s*\{[^}]*\benvVariantSetAction\b[^}]*\}/.test(src);
    expect(hasExport).toBe(true);
  });

  it("exports envVariantUnsetAction", () => {
    const hasExport =
      /export\s+(?:async\s+)?function\s+envVariantUnsetAction\b/.test(src) ||
      /export\s*\{[^}]*\benvVariantUnsetAction\b[^}]*\}/.test(src);
    expect(hasExport).toBe(true);
  });

  it("envVariantSetAction validates the variant against VariantSchema", () => {
    const fnIdx = src.indexOf("export async function envVariantSetAction");
    expect(fnIdx).toBeGreaterThan(-1);
    const next = src.indexOf("export async function", fnIdx + 1);
    const body = src.slice(fnIdx, next === -1 ? undefined : next);
    expect(body).toMatch(/VariantSchema\.safeParse/);
  });

  it("envVariantSetAction validates that the repo exists when one is provided", () => {
    const fnIdx = src.indexOf("export async function envVariantSetAction");
    const next = src.indexOf("export async function", fnIdx + 1);
    const body = src.slice(fnIdx, next === -1 ? undefined : next);
    expect(body).toMatch(/data\.repos\.some/);
  });
});

// ---------------------------------------------------------------------------
// 2. components/secret-dialog.tsx — variant input
// ---------------------------------------------------------------------------
describe("components/secret-dialog.tsx — variant input", () => {
  const src = readSrc("components/secret-dialog.tsx");

  it("FormShape includes optional variant", () => {
    expect(src).toMatch(/variant\?:\s*string/);
  });

  it("renders an input with id 'secret-variant'", () => {
    expect(src).toMatch(/id="secret-variant"/);
  });

  it("variant input lowercases on change (mirrors namespace)", () => {
    // The pattern used for the namespace input: `e.target.value.toLowerCase()`
    // The variant input must follow the same pattern so users don't paste
    // uppercase and confuse themselves.
    const variantIdx = src.indexOf('id="secret-variant"');
    expect(variantIdx).toBeGreaterThan(-1);
    // Grab a window around the input element
    const window = src.slice(variantIdx - 600, variantIdx + 800);
    expect(window).toMatch(/\.toLowerCase\(\)/);
  });

  it("handleSubmit forwards variant to onSubmit", () => {
    // We expect the spread-or-add pattern: `...(v ? { variant: v } : {})`
    expect(src).toMatch(/variant:\s*v/);
  });
});

// ---------------------------------------------------------------------------
// 3. components/secret-pane.tsx — variant chip
// ---------------------------------------------------------------------------
describe("components/secret-pane.tsx — variant chip", () => {
  const src = readSrc("components/secret-pane.tsx");

  it("renders a chip when secret.variant is set", () => {
    expect(src).toMatch(/secret\.variant\s*&&/);
  });

  it("chip title mentions 'variant:'", () => {
    expect(src).toMatch(/title=\{[^}]*variant:/);
  });

  it("toast label includes the variant when set", () => {
    // Look for a label construction that prepends or appends the variant.
    expect(src).toMatch(/form\.variant/);
  });

  // -------------------------------------------------------------------------
  // Phase 4 — Task 9: skippedVariants warning toast on add/update
  // -------------------------------------------------------------------------
  it("warns the operator via toast.warning when skippedVariants is non-empty", () => {
    // The submit handler must call toast.warning (not toast.error / .success)
    // with a message that mentions 'sibling conflict' so the operator knows
    // which cells were silently skipped during auto-scope.
    expect(src).toMatch(/toast\.warning/);
    expect(src).toMatch(/skippedVariants/);
    expect(src).toMatch(/sibling conflict/);
  });
});

// ---------------------------------------------------------------------------
// 4. components/env-variant-dialog.tsx — new dialog
// ---------------------------------------------------------------------------
describe("components/env-variant-dialog.tsx — env-variant management dialog", () => {
  const src = readSrc("components/env-variant-dialog.tsx");

  it("exports EnvVariantDialog as a named export", () => {
    expect(src).toMatch(/export\s+function\s+EnvVariantDialog\b/);
  });

  it("loads the map via envVariantListAction on open", () => {
    expect(src).toMatch(/envVariantListAction/);
  });

  it("mutates via envVariantSetAction and envVariantUnsetAction", () => {
    expect(src).toMatch(/envVariantSetAction/);
    expect(src).toMatch(/envVariantUnsetAction/);
  });

  it("renders a 'Restore defaults' control (NOT 'Disable')", () => {
    expect(src).toMatch(/Restore defaults/);
    // Must not say "Disable auto-scoping" — the empty-map footgun means
    // clearing every override falls back to the default map, not "off".
    expect(src).not.toMatch(/Disable auto-scoping/);
  });

  it("shows the built-in DEFAULT_ENV_VARIANT_MAP for reference", () => {
    // The dialog should consume `view.defaults` returned by envVariantListAction.
    expect(src).toMatch(/defaults/);
  });

  it("supports both global and per-repo overrides", () => {
    expect(src).toMatch(/Global overrides/);
    expect(src).toMatch(/Per-repo overrides/);
  });

  it("accepts a repos prop for the per-repo selector", () => {
    expect(src).toMatch(/repos:\s*Repo\[\]/);
  });
});

// ---------------------------------------------------------------------------
// 5. components/topbar.tsx — mount the EnvVariantDialog + entry point
// ---------------------------------------------------------------------------
describe("components/topbar.tsx — env-variant entry point", () => {
  const src = readSrc("components/topbar.tsx");

  it("imports EnvVariantDialog", () => {
    expect(src).toMatch(
      /import\s*\{\s*EnvVariantDialog\s*\}\s*from\s*['"]@\/components\/env-variant-dialog['"]/,
    );
  });

  it("accepts a repos prop", () => {
    expect(src).toMatch(/repos:\s*Repo\[\]/);
  });

  it("renders an EnvVariantDialog element and passes repos to it", () => {
    expect(src).toMatch(/<EnvVariantDialog/);
    expect(src).toMatch(/repos=\{repos\}/);
  });

  it("opens the dialog from a topbar button", () => {
    // The button should have an aria-label / title mentioning the dialog purpose.
    expect(src).toMatch(/Env\s*→\s*variant\s*map/);
  });
});

// ---------------------------------------------------------------------------
// 6. components/workbench.tsx — passes repos to TopBar
// ---------------------------------------------------------------------------
describe("components/workbench.tsx — wiring", () => {
  const src = readSrc("components/workbench.tsx");

  it("passes repos to TopBar", () => {
    expect(src).toMatch(/repos=\{data\.repos\}/);
  });
});
