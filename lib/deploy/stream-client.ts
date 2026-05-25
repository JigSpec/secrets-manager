/**
 * Shared NDJSON consumer for the streaming deploy endpoint
 * (`POST /api/deploy/stream`). Used by the per-repo Rocket button in
 * `<RepoPane>` and the "Deploy this repo" button in `<RepoSecretsPane>`.
 *
 * NOTE: The deploy-all button in `<TopBar>` deliberately inlines its
 * streaming consumer instead of using this helper — the source-scan tests
 * require `topbar.tsx` to literally contain `fetch("/api/deploy/stream"`,
 * `getReader()`, and `TextDecoder`. Duplicating ~30 lines is cheaper than
 * making the helper source-string-fragile.
 */
import {
  toDeployTargetResult,
  type DeployTargetResult,
} from "@/lib/vault/deploy/result-projection";
import type { DeployTargetResult as RawDeployTargetResult } from "@/lib/vault/deploy/run-deploy";

export type StreamEvent =
  | { kind: "start"; total: number }
  | { kind: "target"; index: number; total: number; result: RawDeployTargetResult }
  | { kind: "done"; results: RawDeployTargetResult[] }
  | { kind: "error"; error: string };

export type StreamHandlers = {
  /** Called once per event in the (0, total) → (N, total) progression. */
  onProgress: (completed: number, total: number, current?: string) => void;
};

export type StreamResult =
  | { ok: true; results: DeployTargetResult[] }
  | { ok: false; error: string };

export async function streamDeploy(
  body: { repoId?: string },
  handlers: StreamHandlers,
): Promise<StreamResult> {
  let res: Response;
  try {
    res = await fetch("/api/deploy/stream", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Network error",
    };
  }

  if (!res.ok) {
    let errorMessage = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { error?: string };
      if (typeof parsed.error === "string") errorMessage = parsed.error;
    } catch {
      // ignore
    }
    return { ok: false, error: errorMessage };
  }

  if (!res.body) {
    return { ok: false, error: "Deploy stream returned no body" };
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let total = 0;
  let finalResults: DeployTargetResult[] | null = null;
  let inbandError: string | null = null;

  // A malformed/truncated NDJSON line (server hiccup, proxy chunking, network
  // corruption) must NOT throw out of the reader loop — callers in
  // `workbench.tsx` and `repo-secrets-pane.tsx` await this function and would
  // otherwise leave the deploy sheet stuck (issue #88, comment 3254830701).
  // Bad lines are logged + skipped so any subsequent well-formed events still
  // dispatch and we can still resolve normally with whatever events arrived.
  const handleLine = (line: string) => {
    if (line.length === 0) return;
    let ev: StreamEvent;
    try {
      ev = JSON.parse(line) as StreamEvent;
    } catch (err) {
      // Never log the raw `line` — it could conceivably contain secret data
      // if a future regression sneaks a value into a target/error payload.
      // Log only the parse error itself.
      // eslint-disable-next-line no-console
      console.warn(
        "streamDeploy: skipping malformed NDJSON line:",
        err instanceof Error ? err.message : String(err),
      );
      return;
    }
    if (ev.kind === "start") {
      total = ev.total;
      handlers.onProgress(0, total);
      return;
    }
    if (ev.kind === "target") {
      const completed = ev.index + 1;
      const current = `${ev.result.repoName} / ${ev.result.env}`;
      handlers.onProgress(completed, total, current);
      return;
    }
    if (ev.kind === "done") {
      finalResults = ev.results.map(toDeployTargetResult);
      return;
    }
    if (ev.kind === "error") {
      inbandError = ev.error;
      return;
    }
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      handleLine(buf.slice(0, nl).trim());
      buf = buf.slice(nl + 1);
      nl = buf.indexOf("\n");
    }
  }
  const tail = buf.trim();
  if (tail.length > 0) handleLine(tail);

  if (inbandError) return { ok: false, error: inbandError };
  if (finalResults === null) {
    return {
      ok: false,
      error: "Deploy stream ended without a done event",
    };
  }
  return { ok: true, results: finalResults };
}
