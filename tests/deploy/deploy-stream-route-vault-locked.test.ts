/**
 * Tests for Issue #101: the deploy stream route must return a structured
 * 401 JSON response when the vault is locked, NOT a streaming response
 * with an empty results set that the client cannot distinguish from a
 * genuine "nothing to deploy" outcome.
 *
 * The fix ensures that:
 *   1. The route already returns `{ status: 401, body: { error: "Vault is locked" } }`
 *      when `getVaultData()` returns null (vault locked). [SOURCE-SCAN]
 *   2. The 401 response body has `content-type: application/json`. [SOURCE-SCAN]
 *   3. When topbar.tsx receives a `!res.ok` response (like a 401), it reads
 *      the JSON body and passes that error string to onDeployFinish. [SOURCE-SCAN]
 *   4. The workbench/parent component wires deployError state to DeploySheet. [SOURCE-SCAN]
 *
 * Some of these source-level assertions already hold (the route already emits
 * 401 JSON for a locked vault). The tests that FAIL are the ones that verify
 * the CLIENT-SIDE handling — specifically that topbar.tsx propagates the
 * parsed error from the 401 response to onDeployFinish's second argument.
 *
 * Test plan:
 *   TC-1 (PASSES already): route.ts returns 401 JSON for locked vault. Verifies
 *         the server already does the right thing — regression guard.
 *   TC-2 (PASSES already): route.ts response body contains 'Vault is locked'.
 *   TC-3 (FAILS before fix): topbar.tsx reads the JSON error from a non-ok
 *         response and passes it as the second arg to onDeployFinish.
 *   TC-4 (FAILS before fix): workbench.tsx declares deployError state.
 *   TC-5 (FAILS before fix): workbench.tsx passes deployError to DeploySheet.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(process.cwd());

function readSrc(relPath: string): string {
  return readFileSync(resolve(root, relPath), "utf8");
}

const routeSrc = readSrc("app/api/deploy/stream/route.ts");
const topbarSrc = readSrc("components/topbar.tsx");
const workbenchSrc = readSrc("components/workbench.tsx");

// ---------------------------------------------------------------------------
// GROUP 1 — Server: route.ts already emits 401 for locked vault
// These tests PASS before the fix and act as regression guards.
// ---------------------------------------------------------------------------

describe("deploy stream route — vault locked response (Issue #101, Group 1, PASSES already)", () => {
  it("TC-1: route.ts returns status 401 when vault is locked (regression guard)", () => {
    // The route already does:
    //   return new Response(JSON.stringify({ error: "Vault is locked" }), { status: 401, ... })
    // This test pins that contract so it can't silently regress.
    const has401 =
      /status\s*:\s*401/.test(routeSrc) ||
      /new Response[\s\S]{0,100}?401/.test(routeSrc);
    expect(
      has401,
      'Expected app/api/deploy/stream/route.ts to return HTTP 401 when the vault is locked. ' +
        "The route must NOT start streaming when the vault is unavailable.",
    ).toBe(true);
  });

  it("TC-2: route.ts 401 response body contains 'Vault is locked' error message (regression guard)", () => {
    const hasVaultIsLocked = /Vault is locked/.test(routeSrc);
    expect(
      hasVaultIsLocked,
      'Expected app/api/deploy/stream/route.ts to include the error message ' +
        '"Vault is locked" in the 401 response body.',
    ).toBe(true);
  });

  it("TC-3: route.ts 401 response has application/json content-type (regression guard)", () => {
    // The route must send JSON (not NDJSON) for the error response so the
    // client can parse it with res.json() in the !res.ok branch.
    const hasJsonContentType = /application\/json/.test(routeSrc);
    expect(
      hasJsonContentType,
      'Expected app/api/deploy/stream/route.ts to set content-type: application/json ' +
        "on the 401 error response body.",
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GROUP 2 — Client: topbar.tsx must pass the parsed error to onDeployFinish
// These tests FAIL before the fix.
// ---------------------------------------------------------------------------

describe("topbar.tsx — non-ok response error passed to onDeployFinish (Issue #101, Group 2)", () => {
  it("TC-4: topbar.tsx parses the JSON body of a non-ok response and reads .error field (FAILS before fix)", () => {
    // Current code attempts to parse the error but then discards it:
    //   const parsed = (await res.json()) as { error?: string };
    //   if (typeof parsed.error === 'string') errorMessage = parsed.error;
    //   toast.error(errorMessage);
    //   onDeployFinish([]);  // <-- error NOT passed here
    //
    // After the fix, the parsed errorMessage must be forwarded:
    //   onDeployFinish([], errorMessage);
    //
    // We verify the combined pattern: error parsing AND forwarding to onDeployFinish.
    // A narrow but reliable check: after the fix, there must be a call site
    // where `onDeployFinish([], <variable or string>)` is present and the
    // variable is derived from the JSON parse (errorMessage or parsed.error).
    //
    // We look for `onDeployFinish([], errorMessage)` or similar patterns that
    // combine the error variable with the finish call.
    const hasErrorForwarding =
      /onDeployFinish\s*\(\s*\[\s*\]\s*,\s*errorMessage/.test(topbarSrc) ||
      /onDeployFinish\s*\(\s*\[\s*\]\s*,\s*parsed\.error/.test(topbarSrc) ||
      /onDeployFinish\s*\(\s*\[\s*\]\s*,\s*[a-zA-Z_][a-zA-Z0-9_]*\s*\)/.test(
        topbarSrc.replace(
          // Remove the no-arg calls to avoid false-positive matching
          /onDeployFinish\s*\(\s*\[\s*\]\s*\)/g,
          "onDeployFinish([]-removed)",
        ),
      );
    expect(
      hasErrorForwarding,
      'Expected topbar.tsx to forward the parsed error string from a non-ok response ' +
        'to onDeployFinish as the second argument (e.g. onDeployFinish([], errorMessage)). ' +
        'Currently onDeployFinish([]) is called with no second argument on error paths.',
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// GROUP 3 — State wiring: workbench.tsx must store and forward deployError
// These tests FAIL before the fix.
// ---------------------------------------------------------------------------

describe("workbench.tsx — deployError state wiring (Issue #101, Group 3)", () => {
  it("TC-5: workbench.tsx declares a deployError state variable (FAILS before fix)", () => {
    // After the fix, workbench.tsx must store the deploy error so it can pass
    // it to DeploySheet. We look for useState with 'deployError'.
    const hasDeployErrorState =
      /deployError/.test(workbenchSrc) &&
      /useState/.test(workbenchSrc);
    // More specific: look for the state declaration pattern
    const hasStateDecl =
      /deployError[,\s].*useState/.test(workbenchSrc) ||
      /useState[\s\S]{0,50}?deployError/.test(workbenchSrc) ||
      /\[deployError\s*,\s*setDeployError\]/.test(workbenchSrc);
    expect(
      hasStateDecl,
      'Expected workbench.tsx to declare a "deployError" state variable ' +
        '(e.g. `const [deployError, setDeployError] = useState<string | null>(null)`). ' +
        'This state is needed to pass the error to DeploySheet.',
    ).toBe(true);
  });

  it("TC-6: workbench.tsx passes deployError prop to DeploySheet (FAILS before fix)", () => {
    // After the fix, the <DeploySheet> JSX must include a `deployError` prop.
    const hasDeployErrorProp =
      /deployError\s*=\s*\{/.test(workbenchSrc) ||
      /deployError=\{/.test(workbenchSrc);
    expect(
      hasDeployErrorProp,
      'Expected workbench.tsx to pass `deployError={deployError}` (or similar) ' +
        'to the <DeploySheet> component. Currently DeploySheet receives no error prop.',
    ).toBe(true);
  });

  it("TC-7: workbench.tsx onDeployFinish signature accepts a second error parameter (FAILS before fix)", () => {
    // The onDeployFinish callback in workbench.tsx must accept the error
    // forwarded from topbar. We look for the updated callback signature.
    const hasErrorInOnDeployFinish =
      /onDeployFinish\s*=\s*useCallback[\s\S]{0,100}?\([^)]*error/.test(workbenchSrc) ||
      /onDeployFinish\s*\([^)]*error/.test(workbenchSrc) ||
      /\(results[^)]*,\s*error/.test(workbenchSrc);
    expect(
      hasErrorInOnDeployFinish,
      'Expected workbench.tsx onDeployFinish callback to accept a second error parameter. ' +
        'After the fix, it should set the deployError state from this parameter.',
    ).toBe(true);
  });
});
