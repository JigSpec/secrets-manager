/**
 * Streaming deploy Route Handler — emits NDJSON `start` → N×`target` → `done`
 * events as `runDeploy` advances through targets, so the GUI progress bar
 * can update once per target instead of jumping from 0/N to N/N (issue #76).
 *
 * NOTE: Route Handlers are server-only by default — DO NOT add `"use server"`
 * here (that would convert the module to a Server Actions module and break
 * the Route Handler export contract).
 *
 * Wire protocol (one JSON value per line, separated by `\n`):
 *
 *   1.   { kind: "start",  total: N }
 *   2.   { kind: "target", index: 0..N-1, total: N, result: DeployTargetResult }
 *        … one per finished target, in iteration order …
 *   3.   { kind: "done",   results: DeployTargetResult[] }
 *
 *   Error frames (200 stream): { kind: "error", error: string } before close.
 *
 *   EXCEPTION — early-validation errors (e.g. unknown `repoId`) intentionally
 *   omit `start` and `done`: the stream emits a single `error` frame and
 *   closes. Consumers (`stream-client.ts` and `topbar.tsx`) handle this by
 *   checking for an `inbandError` before requiring a `done` event, so a
 *   strict `start → … → done` consumer would need to accept this exception.
 */
import {
  enumerateTargets,
  runDeploy,
  targetsForRepo,
  type DeployTarget,
  type DeployTargetResult,
} from "@/lib/vault/deploy/run-deploy";
import { getVaultData } from "@/lib/vault/session";
import { VAULT_LOCKED_ERROR } from "@/lib/vault/errors";

// `dotenvx-ops` shells out; Edge would break. Tests use dryRun: true so they
// never exercise this path, but production needs Node.
export const runtime = "nodejs";

type StartEvent = { kind: "start"; total: number };
type TargetEvent = {
  kind: "target";
  index: number;
  total: number;
  result: DeployTargetResult;
};
type DoneEvent = { kind: "done"; results: DeployTargetResult[] };
type ErrorEvent = { kind: "error"; error: string };

const NDJSON_CONTENT_TYPE = "application/x-ndjson; charset=utf-8";

function ndjsonResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, {
    status: 200,
    headers: { "content-type": NDJSON_CONTENT_TYPE },
  });
}

function singleEventStream(event: ErrorEvent): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      controller.close();
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  let body: { repoId?: string; dryRun?: boolean } = {};
  try {
    body = (await req.json()) as { repoId?: string; dryRun?: boolean };
  } catch {
    // Empty / malformed body is acceptable — equivalent to "deploy all".
  }

  const data = await getVaultData();
  if (!data) {
    // VAULT_LOCKED_ERROR = "Vault is locked"
    return new Response(JSON.stringify({ error: VAULT_LOCKED_ERROR }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  // Per-repo validation BEFORE we start streaming so we can emit a structured
  // error event in-band. The test accepts EITHER a 4xx with JSON body OR a
  // 200 stream with an in-band error frame; we prefer the in-band frame so
  // the GUI's progress sheet renders a typed error instead of swallowing a
  // 4xx.
  let targets: DeployTarget[];
  if (body.repoId !== undefined) {
    const repo = data.repos.find((r) => r.id === body.repoId);
    if (!repo) {
      return ndjsonResponse(
        singleEventStream({
          kind: "error",
          error: `Unknown repoId: ${body.repoId}`,
        }),
      );
    }
    targets = targetsForRepo(data, body.repoId);
  } else {
    targets = enumerateTargets(data);
  }

  const total = targets.length;
  const dryRun = body.dryRun === true;
  const encoder = new TextEncoder();
  const signal = req.signal;

  // Sentinel thrown by `onTarget` when the request is aborted mid-deploy,
  // so the `runDeploy` loop unwinds cleanly without keeping us iterating
  // over `targetsForRepo(...)`. Caught below and translated into a quiet
  // close (no error event — the client is already gone).
  const ABORT_SENTINEL = Symbol("deploy-stream/aborted");

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // True once the controller has been closed (either by abort or by
      // normal completion). Subsequent `enqueue` calls would throw with
      // "enqueue after close" — we no-op instead so a late `onTarget`
      // callback can't crash the route after the client aborts.
      let closed = false;
      const closeOnce = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // Already closed — fine.
        }
      };

      // `req.signal` lets us cancel server-side work when the client
      // navigates/aborts mid-deploy. Without this, `runDeploy` keeps
      // writing `.env` files for the remaining targets and every late
      // `enqueue(...)` throws (issue #88, comment 3254830704).
      const onAbort = () => {
        closeOnce();
      };
      if (signal.aborted) {
        closeOnce();
        return;
      }
      signal.addEventListener("abort", onAbort);

      const enqueue = (obj: unknown) => {
        if (closed || signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
        } catch {
          // Controller already closed by an abort race — swallow.
          closed = true;
        }
      };

      try {
        // Emit `start` BEFORE running any targets so the first chunk the
        // client receives parses as the start event (proves the route streams
        // incrementally rather than batching to the end).
        const startEvent: StartEvent = { kind: "start", total };
        enqueue(startEvent);

        let results: DeployTargetResult[];
        try {
          results = await runDeploy({
            data,
            targets,
            dryRun,
            onTarget: (result, index) => {
              if (signal.aborted) {
                // Stop iterating remaining targets — runDeploy will catch
                // this and the outer `try` translates it into a quiet close.
                throw ABORT_SENTINEL;
              }
              const ev: TargetEvent = {
                kind: "target",
                index,
                total,
                result,
              };
              enqueue(ev);
            },
          });
        } catch (err) {
          if (err === ABORT_SENTINEL || signal.aborted) {
            // Client cancelled — close quietly, no error frame (the
            // browser already abandoned the connection).
            closeOnce();
            return;
          }
          // SECURITY: this is a secrets-handling surface. `err.message`
          // could in theory contain a secret value if a future change ever
          // bubbles a child-process stderr (or similar) through
          // `runDeploy`'s throw path — and the user might copy-paste this
          // toast for support, leaking plaintext off the host. So we send a
          // typed generic to the client and log the real message
          // server-side only. (#88, comment 3254830707.)
          // eslint-disable-next-line no-console
          console.error("[deploy/stream] runDeploy threw:", err);
          const errEvent: ErrorEvent = {
            kind: "error",
            error: "Deploy failed: internal error",
          };
          enqueue(errEvent);
          closeOnce();
          return;
        }

        if (!signal.aborted) {
          const doneEvent: DoneEvent = { kind: "done", results };
          enqueue(doneEvent);
        }
        closeOnce();
      } finally {
        signal.removeEventListener("abort", onAbort);
      }
    },
  });

  return ndjsonResponse(stream);
}
