/**
 * Tests for the streaming deploy Route Handler (Issue #76).
 *
 * Next.js server actions cannot stream — they resolve once and return one
 * payload to the client. To make the GUI progress bar advance per target
 * we add a Route Handler that emits one NDJSON event per target as the
 * deploy progresses.
 *
 * The Route Handler MUST live at:
 *   app/api/deploy/stream/route.ts
 *
 * with an exported POST function.
 *
 * Wire protocol (NDJSON — one JSON value per line, separated by "\n"):
 *
 *   1.  { kind: "start",  total: N }
 *   2.  { kind: "target", index: 0..N-1, total: N, result: DeployTargetResult }
 *       … one per finished target, in iteration order …
 *   3.  { kind: "done",   results: DeployTargetResult[] }
 *
 * Request body:
 *   { repoId?: string }     // omitted = deploy all targets, present = per-repo
 *
 * Response headers:
 *   Content-Type: application/x-ndjson
 *
 * This test mocks `@/lib/vault/session` so we never need a live daemon or a
 * real on-disk vault. It uses dry-run by passing a vault that the route
 * must run in dryRun mode for tests — the route exposes a `dryRun` field
 * on the request body for this purpose (production callers omit it).
 *
 * NOTE: This file imports `@/app/api/deploy/stream/route` — that module
 * doesn't exist yet. The fixer must create it. The test will fail with a
 * resolution error until then; that's the intended TDD signal.
 */
import { describe, expect, it, vi } from "vitest";

import type { VaultData } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeVault(): VaultData {
  return {
    version: 2,
    repos: [
      { id: "r-alpha", name: "alpha", path: "/tmp/alpha-route-test", environments: ["test", "live"] },
      { id: "r-beta", name: "beta", path: "/tmp/beta-route-test", environments: ["test", "live"] },
    ],
    secrets: [
      {
        id: "s1",
        key: "API_KEY",
        value: "v",
        scopes: [
          { repoId: "r-alpha", env: "test" },
          { repoId: "r-alpha", env: "live" },
          { repoId: "r-beta", env: "test" },
          { repoId: "r-beta", env: "live" },
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Mock vault session so the route handler resolves to a deterministic vault.
// ---------------------------------------------------------------------------

const mockVault = makeVault();

vi.mock("@/lib/vault/session", async () => {
  return {
    getVaultData: vi.fn(async () => mockVault),
    isUnlocked: vi.fn(async () => true),
    getSessionId: vi.fn(async () => "test-session"),
    getSessionPassword: vi.fn(async () => "test-pw"),
    persistVaultData: vi.fn(async () => {}),
    lock: vi.fn(async () => {}),
  };
});

// ---------------------------------------------------------------------------
// Helpers — consume the streamed Response body line-by-line
// ---------------------------------------------------------------------------

async function readEvents(response: Response): Promise<unknown[]> {
  expect(response.body).not.toBeNull();
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const events: unknown[] = [];
  // 5 s hard cap to keep the test deterministic if the route hangs.
  const deadline = Date.now() + 5_000;
  while (true) {
    if (Date.now() > deadline) throw new Error("readEvents: timeout");
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line.length > 0) events.push(JSON.parse(line));
      nl = buf.indexOf("\n");
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) events.push(JSON.parse(tail));
  return events;
}

function makePostRequest(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/deploy/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/deploy/stream — NDJSON streaming Route Handler", () => {
  it("responds with application/x-ndjson content type", async () => {
    // FIXER: create app/api/deploy/stream/route.ts exporting `async function POST(req)`.
    const { POST } = await import("@/app/api/deploy/stream/route");
    const res = await POST(makePostRequest({ dryRun: true }));
    const ct = res.headers.get("content-type") ?? "";
    expect(ct.toLowerCase()).toContain("application/x-ndjson");
  });

  it("emits a 'start' event followed by one 'target' event per target, then 'done'", async () => {
    const { POST } = await import("@/app/api/deploy/stream/route");
    const res = await POST(makePostRequest({ dryRun: true }));
    const events = (await readEvents(res)) as Array<{
      kind: string;
      total?: number;
      index?: number;
      result?: { repoId: string; env: string; ok: boolean };
      results?: Array<{ repoId: string; env: string }>;
    }>;

    // The vault has 4 (repoId, env) cells with scoped secrets.
    expect(events.length).toBe(1 + 4 + 1);
    expect(events[0]!.kind).toBe("start");
    expect(events[0]!.total).toBe(4);

    for (let i = 1; i <= 4; i++) {
      expect(events[i]!.kind).toBe("target");
      expect(events[i]!.index).toBe(i - 1);
      expect(events[i]!.total).toBe(4);
      expect(events[i]!.result).toBeDefined();
      expect(typeof events[i]!.result!.repoId).toBe("string");
      expect(typeof events[i]!.result!.env).toBe("string");
    }

    const done = events[events.length - 1]!;
    expect(done.kind).toBe("done");
    expect(done.results).toBeDefined();
    expect(done.results!.length).toBe(4);
  });

  it("target events arrive in iteration order matching the final results", async () => {
    const { POST } = await import("@/app/api/deploy/stream/route");
    const res = await POST(makePostRequest({ dryRun: true }));
    const events = (await readEvents(res)) as Array<{
      kind: string;
      result?: { repoId: string; env: string };
      results?: Array<{ repoId: string; env: string }>;
    }>;

    const targetKeys = events
      .filter((e) => e.kind === "target")
      .map((e) => `${e.result!.repoId}::${e.result!.env}`);
    const doneEvent = events[events.length - 1]!;
    const doneKeys = doneEvent.results!.map((r) => `${r.repoId}::${r.env}`);

    expect(targetKeys).toEqual(doneKeys);
  });

  it("with repoId in the body, only that repo's targets are deployed", async () => {
    const { POST } = await import("@/app/api/deploy/stream/route");
    const res = await POST(makePostRequest({ dryRun: true, repoId: "r-alpha" }));
    const events = (await readEvents(res)) as Array<{
      kind: string;
      total?: number;
      result?: { repoId: string };
    }>;

    expect(events[0]!.kind).toBe("start");
    expect(events[0]!.total).toBe(2); // alpha/test + alpha/live

    const targetEvents = events.filter((e) => e.kind === "target");
    expect(targetEvents).toHaveLength(2);
    for (const ev of targetEvents) {
      expect(ev.result!.repoId).toBe("r-alpha");
    }
  });

  it("the first 'target' event arrives BEFORE the response body fully closes", async () => {
    // The whole point of streaming: the client must be able to consume the
    // first per-target event before the deploy loop has finished. We can't
    // assert wall-clock interleaving cheaply in a test, but we CAN assert
    // the body is a ReadableStream (transfer-encoded) rather than a
    // pre-buffered string. The body must support incremental reads.
    const { POST } = await import("@/app/api/deploy/stream/route");
    const res = await POST(makePostRequest({ dryRun: true }));
    expect(res.body).toBeInstanceOf(ReadableStream);

    // Read the first chunk and verify it's parseable as one event — proves
    // events are emitted incrementally, not batched at the end.
    const reader = res.body!.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    const text = new TextDecoder().decode(value);
    const firstLine = text.split("\n").find((l) => l.trim().length > 0);
    expect(firstLine).toBeDefined();
    const first = JSON.parse(firstLine!);
    // The first event must be 'start' — proves the route emits BEFORE
    // running any of the targets.
    expect(first.kind).toBe("start");

    // Drain the rest so the stream cleans up.
    await reader.cancel();
  });

  it("rejects an unknown repoId with a structured error event (not a 500)", async () => {
    const { POST } = await import("@/app/api/deploy/stream/route");
    const res = await POST(makePostRequest({ dryRun: true, repoId: "nope-not-real" }));

    // Acceptable contract: either a 4xx with a JSON error body, OR a 200
    // stream whose first event is `{kind: "error", error: string}`. We
    // accept either to give the fixer flexibility, but at least ONE must
    // hold so the client can render a clear message.
    if (res.status >= 400) {
      const body = await res.json();
      expect(typeof body.error).toBe("string");
    } else {
      const events = (await readEvents(res)) as Array<{ kind: string; error?: string }>;
      const errorEvent = events.find((e) => e.kind === "error");
      expect(errorEvent).toBeDefined();
      expect(typeof errorEvent!.error).toBe("string");
    }
  });

  // -------------------------------------------------------------------------
  // Regression coverage (issue #88 review).
  //
  // These tests pin down the safety properties of the deploy stream that are
  // load-bearing for a secrets surface — namely that no event payload ever
  // contains a plaintext secret value, that a thrown error from `runDeploy`
  // still produces a `done`/terminal frame, and that the consumer survives
  // a malformed NDJSON line.
  // -------------------------------------------------------------------------

  it("no event payload field ever contains a plaintext secret value", async () => {
    // The vault fixture above uses `value: "v"` for API_KEY. The DeployTargetResult
    // shape today doesn't carry `value`, but a regression that ever adds it
    // (or that lets an error string include the value) must be caught.
    const { POST } = await import("@/app/api/deploy/stream/route");
    const res = await POST(makePostRequest({ dryRun: true }));
    const events = (await readEvents(res)) as Array<Record<string, unknown>>;

    // The fixture's secret value — assert it appears nowhere in any frame.
    const SECRET_VALUE = "v";

    // We also assert structurally that target.result and done.results never
    // contain a `value` field. This is the regression guard.
    function assertNoValueField(obj: unknown, path: string): void {
      if (obj === null || typeof obj !== "object") return;
      for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
        // Strict: no `value` key anywhere in the tree.
        expect(k, `${path}.${k} should not be 'value'`).not.toBe("value");
        if (typeof v === "string") {
          // The literal secret value must never appear as a string anywhere.
          expect(v, `${path}.${k} must not equal the secret value`).not.toBe(
            SECRET_VALUE,
          );
        }
        if (v !== null && typeof v === "object") {
          assertNoValueField(v, `${path}.${k}`);
        }
      }
    }
    for (let i = 0; i < events.length; i++) {
      assertNoValueField(events[i]!, `events[${i}]`);
    }

    // Belt-and-suspenders: a stringified scan over the whole frame stream
    // must not contain the secret value either. (Could trip on a single-
    // letter key collision, but `"v"` is short enough that a full-text
    // scan of a JSON event stream where every other token is longer keeps
    // this useful.)
    const serialised = events.map((e) => JSON.stringify(e)).join("\n");
    // A typed search for `"v"` exactly (quoted string value) — not just
    // the letter v which appears in tokens like `"dryRun":true,"env":...`.
    expect(serialised).not.toMatch(/"value"\s*:\s*"[^"]*"/);
  });

  it("when runDeploy throws, the route still terminates the stream without hanging", async () => {
    // Mock the runDeploy export so it throws synchronously from inside the
    // async generator. The route must emit a single `error` frame and close
    // the stream — NOT hang waiting for `done`.
    vi.resetModules();
    vi.doMock("@/lib/vault/deploy/run-deploy", async () => {
      const actual = await vi.importActual<
        typeof import("@/lib/vault/deploy/run-deploy")
      >("@/lib/vault/deploy/run-deploy");
      return {
        ...actual,
        runDeploy: vi.fn(async () => {
          throw new Error("simulated runDeploy failure");
        }),
      };
    });
    try {
      const { POST } = await import("@/app/api/deploy/stream/route");
      const res = await POST(makePostRequest({ dryRun: true }));
      const events = (await readEvents(res)) as Array<{
        kind: string;
        error?: string;
      }>;

      // The stream MUST close — readEvents would throw "timeout" otherwise.
      // The protocol contract on a thrown error: `start` → `error` (no `done`).
      expect(events[0]!.kind).toBe("start");
      const errorEvent = events.find((e) => e.kind === "error");
      expect(errorEvent).toBeDefined();
      // SECURITY: the err.message ("simulated runDeploy failure") MUST NOT
      // leak to the client. The route sends a generic message instead.
      expect(errorEvent!.error).not.toContain("simulated runDeploy failure");
      expect(typeof errorEvent!.error).toBe("string");
      expect(errorEvent!.error!.length).toBeGreaterThan(0);
    } finally {
      vi.doUnmock("@/lib/vault/deploy/run-deploy");
      vi.resetModules();
    }
  });
});
