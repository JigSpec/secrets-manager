"use client";

import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import type { DeployTargetResult } from "@/app/actions";
import { VAULT_LOCKED_ERROR } from "@/lib/vault/errors";

/**
 * Progress info surfaced while a deploy is running.
 *
 * - `total` is the number of `(repoId, env)` targets the parent is
 *   deploying to.
 * - `completed` is how many have finished so far (0 → total).
 * - `current` (optional) is a human-readable label for the target
 *   currently being processed, e.g. `"acme-api / live"`.
 */
export type DeployProgress = {
  completed: number;
  total: number;
  current?: string;
};

export function DeploySheet({
  open,
  onOpenChange,
  results,
  deploying,
  progress,
  deployError,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  results: DeployTargetResult[] | null;
  deploying: boolean;
  progress: DeployProgress;
  deployError: string | null;
}) {
  const total = Math.max(0, progress.total);
  const completed = Math.max(0, Math.min(progress.completed, total));
  const pct = total > 0 ? Math.round((completed / total) * 100) : 0;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-xl"
        hideClose={deploying}
        onEscapeKeyDown={(e) => {
          if (deploying) e.preventDefault();
        }}
        onPointerDownOutside={(e) => {
          if (deploying) e.preventDefault();
        }}
      >
        <DialogHeader>
          <DialogTitle>Encrypt &amp; Deploy</DialogTitle>
          <DialogDescription>
            Each (repo, env) target writes a <code className="font-mono">.env.&lt;env&gt;</code> file
            with the public key + encrypted owned values.
          </DialogDescription>
        </DialogHeader>
        {deploying ? (
          <div className="py-4" data-testid="deploy-progress">
            <div className="mb-2 flex items-center justify-between gap-2 text-xs text-muted-foreground">
              <span className="flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {progress.current
                  ? `Deploying ${progress.current}…`
                  : "Encrypting & deploying…"}
              </span>
              <span className="font-mono tabular-nums">
                {completed} / {total}
              </span>
            </div>
            <progress
              className="h-2 w-full overflow-hidden rounded-full bg-secondary [&::-webkit-progress-bar]:bg-secondary [&::-webkit-progress-value]:bg-primary [&::-moz-progress-bar]:bg-primary"
              value={completed}
              max={Math.max(total, 1)}
              aria-label={`Deploy progress: ${completed} of ${total} targets`}
              aria-valuenow={completed}
              aria-valuemin={0}
              aria-valuemax={total}
            />
            <div className="mt-2 text-[11px] text-muted-foreground">
              {pct}% — please don&apos;t close this window.
            </div>
          </div>
        ) : deployError !== null ? (
          <div className="py-6 text-sm text-destructive" data-testid="deploy-error-message">
            {deployError === VAULT_LOCKED_ERROR
              ? "Your vault session has expired. Please lock and re-unlock the vault, then deploy again."
              : deployError}
          </div>
        ) : results === null ? (
          <div className="py-6 text-sm text-muted-foreground">
            No deploy ran.
          </div>
        ) : results.length === 0 ? (
          <div className="py-6 text-sm text-muted-foreground">
            Nothing to deploy yet — assign a secret to at least one scope cell first.
          </div>
        ) : (
          <ul className="max-h-[60vh] divide-y divide-border overflow-y-auto">
            {results.map((r) => (
              <li
                key={`${r.repoId}::${r.env}`}
                className="flex items-start gap-3 py-3"
              >
                <span className="mt-0.5">
                  {r.ok ? (
                    <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                  ) : (
                    <XCircle className="h-4 w-4 text-destructive" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-medium">{r.repoName}</span>
                    <span className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide">
                      {r.env}
                    </span>
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    {r.repoPath}
                  </div>
                  {r.ok ? (
                    <div className="mt-1 text-xs text-emerald-700">
                      Wrote {r.ownedKeyCount} key
                      {r.ownedKeyCount === 1 ? "" : "s"} →{" "}
                      <code className="font-mono">.env.{r.env}</code>
                    </div>
                  ) : (
                    <div className="mt-1 text-xs text-destructive">{r.error}</div>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </DialogContent>
    </Dialog>
  );
}
