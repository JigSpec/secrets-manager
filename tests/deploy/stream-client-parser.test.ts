/**
 * Tests for the shared NDJSON consumer in `lib/deploy/stream-client.ts`.
 *
 * The consumer is used by `<RepoPane>`'s Rocket icon-button and
 * `<RepoSecretsPane>`'s "Deploy this repo" button. A malformed/truncated
 * NDJSON line MUST NOT throw out of the reader loop — otherwise the
 * `await streamDeploy(...)` rejects and the deploy sheet hangs (issue #88,
 * comments 3254830701 / 3254830717 / 3254830724).
 *
 * We mock `fetch` to feed a `ReadableStream` of crafted NDJSON bytes,
 * then assert the consumer:
 *   1. dispatches well-formed events on either side of a malformed line, and
 *   2. resolves normally rather than rejecting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { streamDeploy } from "@/lib/deploy/stream-client";

function makeStreamResponse(ndjson: string): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(ndjson));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
}

describe("streamDeploy — NDJSON consumer robustness", () => {
  const realFetch = globalThis.fetch;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    warnSpy.mockRestore();
  });

  it("tolerates a malformed NDJSON line: well-formed events on either side still dispatch", async () => {
    // The middle line is invalid JSON (`{garbage`). The parser must skip
    // it without throwing so the trailing `done` event still resolves
    // the promise normally.
    const goodResult = {
      ok: true,
      repoId: "r-alpha",
      repoName: "alpha",
      repoPath: "/tmp/a",
      env: "test",
      ownedKeyCount: 1,
      writtenKeys: ["API_KEY"],
    };
    const ndjson =
      JSON.stringify({ kind: "start", total: 2 }) +
      "\n" +
      "{this is not valid json" +
      "\n" +
      JSON.stringify({
        kind: "target",
        index: 0,
        total: 2,
        result: goodResult,
      }) +
      "\n" +
      JSON.stringify({ kind: "done", results: [goodResult] }) +
      "\n";

    globalThis.fetch = vi.fn(async () => makeStreamResponse(ndjson)) as typeof fetch;

    const progressCalls: Array<[number, number, string | undefined]> = [];
    const result = await streamDeploy(
      {},
      {
        onProgress: (completed, total, current) =>
          progressCalls.push([completed, total, current]),
      },
    );

    // The promise must resolve — NOT reject — even with the malformed line.
    expect(result.ok).toBe(true);
    // Both well-formed events dispatched: start (0,2) and target (1,2).
    expect(progressCalls.length).toBeGreaterThanOrEqual(2);
    expect(progressCalls[0]![0]).toBe(0);
    expect(progressCalls[0]![1]).toBe(2);
    // The target event after the malformed line still fired.
    expect(progressCalls.some(([completed]) => completed === 1)).toBe(true);
    // And we logged a warning for the bad line.
    expect(warnSpy).toHaveBeenCalled();
  });

  it("does not include the raw malformed line in the log message", async () => {
    // Belt-and-suspenders: if a malformed line ever contained secret data
    // (which would be a separate bug), the warning must not echo it.
    const sensitiveBadLine = "{not-json-but-contains-SECRET-VALUE-marker";
    const ndjson =
      JSON.stringify({ kind: "start", total: 0 }) +
      "\n" +
      sensitiveBadLine +
      "\n" +
      JSON.stringify({ kind: "done", results: [] }) +
      "\n";

    globalThis.fetch = vi.fn(async () => makeStreamResponse(ndjson)) as typeof fetch;

    await streamDeploy({}, { onProgress: () => {} });

    // No warning call should contain the raw bad line content.
    for (const call of warnSpy.mock.calls) {
      const joined = call.map(String).join(" ");
      expect(joined).not.toContain("SECRET-VALUE-marker");
    }
  });

  it("resolves with ok:false when the stream ends without a done event (no hang)", async () => {
    const ndjson = JSON.stringify({ kind: "start", total: 1 }) + "\n";
    globalThis.fetch = vi.fn(async () => makeStreamResponse(ndjson)) as typeof fetch;

    const result = await streamDeploy({}, { onProgress: () => {} });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/done event/i);
    }
  });
});
