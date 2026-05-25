"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { BookOpen, Eye, EyeOff, FolderGit2, Pencil, Rocket, Trash2 } from "lucide-react";
import type { Repo, Secret, VaultData } from "@/lib/vault/schema";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  toggleScopeAction,
  updateSecretAction,
  deleteSecretAction,
  type DeployTargetResult,
} from "@/app/actions";
import { streamDeploy } from "@/lib/deploy/stream-client";
import { secretsForRepo, groupSecretsByEnv } from "@/lib/vault/repo-secrets";
import { SecretDialog } from "@/components/secret-dialog";
import { ViewTutorialDialog } from "@/components/view-tutorial-dialog";
import { useRevealAll } from "@/hooks/use-reveal-all";

// NOTE: `deployRepoAction` is no longer imported here — this pane now uses
// `streamDeploy` so the deploy progress sheet can advance one target at a
// time (issue #76). The server action remains exported from `app/actions.ts`
// for any external callers; importing it just to silence an unused-import
// warning was a smell (issue #88, comment 3254830722).

interface RepoSecretsPaneProps {
  repo: Repo;
  secrets: Secret[];
  onChange: (next: VaultData) => void;
  /** True while any deploy (this repo's or another) is in flight. */
  deploying: boolean;
  /** Called when this pane initiates a deploy. Passes the target count up. */
  onDeployStart: (total: number, current?: string) => void;
  /** Called when the deploy resolves with per-target results. */
  onDeployFinish: (results: DeployTargetResult[]) => void;
  /** Called once per streamed target so the shared deploy sheet advances. */
  onDeployProgress: (
    completed: number,
    total: number,
    current?: string,
  ) => void;
}

export function RepoSecretsPane({
  repo,
  secrets,
  onChange,
  deploying,
  onDeployStart,
  onDeployFinish,
  onDeployProgress,
}: RepoSecretsPaneProps) {
  const [isPending, startTransition] = useTransition();
  const [deployPending, setDeployPending] = useState(false);
  const [pendingUnscope, setPendingUnscope] = useState<{
    secretId: string;
    env: string;
    key: string;
  } | null>(null);
  // Issue #1/#2/#3/#5: reveal state managed by shared hook; resets on repo change.
  const { revealAll, revealed, toggleRevealAll, toggleReveal } = useRevealAll(repo.id);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Secret | null>(null);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialSecretId, setTutorialSecretId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Secret | null>(null);

  const tutorialSecret = useMemo(
    () =>
      tutorialSecretId
        ? (secrets.find((s) => s.id === tutorialSecretId) ?? null)
        : null,
    [secrets, tutorialSecretId],
  );

  // If the secret being viewed in the tutorial disappears (deleted externally,
  // vault re-import, etc.), close the tutorial dialog and clear the target.
  useEffect(() => {
    if (tutorialOpen && tutorialSecretId && !tutorialSecret) {
      setTutorialOpen(false);
      setTutorialSecretId(null);
    }
  }, [tutorialOpen, tutorialSecretId, tutorialSecret]);

  // Count distinct (repoId, env) deploy targets for this repo — every env
  // that has at least one scoped secret. Mirrors `targetsForRepo` server-side.
  const deployTargetCount = useMemo(() => {
    const set = new Set<string>();
    for (const s of secrets) {
      for (const sc of s.scopes) {
        if (sc.repoId === repo.id) set.add(sc.env);
      }
    }
    return set.size;
  }, [secrets, repo.id]);

  if (repo.environments.length === 0) {
    return (
      <section className="flex h-full flex-col items-center justify-center bg-card/10 p-8 text-center">
        <FolderGit2 className="mb-4 h-10 w-10 text-muted-foreground/50" />
        <h2 className="text-sm font-semibold">This repo has no environments configured</h2>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          Edit the repo to add environments before assigning secrets.
        </p>
      </section>
    );
  }

  const repoSecrets = secretsForRepo(secrets, repo.id);
  const grouped = groupSecretsByEnv(repoSecrets, repo);

  // Total unique secrets assigned to this repo
  const totalCount = repoSecrets.length;

  function handleConfirmUnscope() {
    if (!pendingUnscope) return;
    const { secretId, env } = pendingUnscope;
    startTransition(async () => {
      const r = await toggleScopeAction({
        secretId,
        repoId: repo.id,
        env,
        next: false,
      });
      if (!r.ok) {
        toast.error(r.error);
        // Keep the dialog open so the user sees the error; don't clear pendingUnscope.
      } else {
        onChange(r.data);
        setPendingUnscope(null);
      }
    });
  }

  function handleDeleteSecret(secret: Secret) {
    setPendingDelete(secret);
  }

  function handleConfirmDelete() {
    if (!pendingDelete) return;
    const secret = pendingDelete;
    startTransition(async () => {
      const r = await deleteSecretAction(secret.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      onChange(r.data);
      setPendingDelete(null);
      toast.success(`Removed "${secret.key}".`);
    });
  }

  async function handleEditSubmit(form: { key: string; value: string; namespace?: string; description?: string }) {
    if (!editing) return { error: "No secret selected." };
    return new Promise<{ ok: true } | { error: string }>((resolve) => {
      startTransition(async () => {
        const r = await updateSecretAction({ id: editing.id, ...form });
        if (!r.ok) {
          resolve({ error: r.error });
          return;
        }
        onChange(r.data);
        toast.success(`Updated "${form.key}".`);
        resolve({ ok: true as const });
      });
    });
  }

  async function handleDeployRepo() {
    if (deployTargetCount === 0) return;
    onDeployStart(deployTargetCount, `${repo.name}`);
    setDeployPending(true);
    try {
      const r = await streamDeploy(
        { repoId: repo.id },
        { onProgress: onDeployProgress },
      );
      if (!r.ok) {
        toast.error(r.error);
        onDeployFinish([]);
        return;
      }
      onDeployFinish(r.results);
      const failed = r.results.filter((x) => !x.ok).length;
      if (failed === 0) {
        toast.success(
          r.results.length === 0
            ? `Nothing to deploy for "${repo.name}".`
            : `Deployed ${r.results.length} target${r.results.length === 1 ? "" : "s"} for "${repo.name}".`,
        );
      } else {
        toast.error(
          `${failed} target${failed === 1 ? "" : "s"} failed. See sheet for details.`,
        );
      }
    } catch (err) {
      // Defensive: even with the stream-client parser hardened, the fetch
      // itself can throw (network teardown). Without this catch
      // `deploying` (driven by `onDeployFinish` in the parent) would stay
      // true and the sheet would hang (issue #88, comment 3254830724).
      toast.error(err instanceof Error ? err.message : "Deploy failed.");
      onDeployFinish([]);
    } finally {
      setDeployPending(false);
    }
  }

  return (
    <>
      <section className="flex h-full min-h-0 flex-col bg-card/10" aria-label={`Secrets for ${repo.name}`} aria-busy={isPending}>
        <header className="shrink-0 border-b border-border px-6 py-3">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Repo secrets
              </div>
              <div className="mt-1 truncate font-medium text-sm">
                {repo.name}
              </div>
              <div className="text-xs text-muted-foreground">
                {totalCount} unique secret{totalCount === 1 ? "" : "s"} assigned
                {deployTargetCount > 0 && (
                  <>
                    {" · "}
                    {deployTargetCount} deploy target
                    {deployTargetCount === 1 ? "" : "s"}
                  </>
                )}
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={toggleRevealAll}
                aria-label={revealAll ? "Hide all values" : "Reveal all values"}
                title={revealAll ? "Hide all secret values" : "Reveal all secret values"}
              >
                {revealAll ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
                {revealAll ? "Hide all" : "Reveal all"}
              </Button>
              <Button
                size="sm"
                onClick={handleDeployRepo}
                disabled={deployTargetCount === 0 || deploying || deployPending}
                title={
                  deployTargetCount === 0
                    ? "Assign at least one secret to this repo before deploying."
                    : `Deploy ${deployTargetCount} target${deployTargetCount === 1 ? "" : "s"} for ${repo.name}`
                }
              >
                <Rocket className="h-4 w-4" />
                {deploying || deployPending ? "Deploying…" : "Deploy this repo"}
              </Button>
            </div>
          </div>
        </header>
        <div className="flex-1 min-h-0 overflow-auto p-6 space-y-6">
          {repo.environments.map((env) => {
            const envSecrets = grouped.get(env) ?? [];
            return (
              <div key={env}>
                <div className="mb-2 flex items-center gap-2">
                  <h3 id={`env-heading-${env}`} className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {env}
                  </h3>
                  <span className="rounded-full bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                    {envSecrets.length}
                  </span>
                </div>
                {envSecrets.length === 0 ? (
                  <p className="text-xs text-muted-foreground">
                    No secrets assigned to this environment
                  </p>
                ) : (
                  <ul className="space-y-1" aria-labelledby={`env-heading-${env}`}>
                    {envSecrets.map((secret) => (
                      <li
                        key={secret.id}
                        className="group flex items-center gap-2 rounded-md border border-border bg-card/20 px-3 py-2"
                      >
                        <Button
                          variant="ghost"
                          size="icon"
                          disabled={isPending}
                          aria-label={`Remove ${secret.key} from ${repo.name} / ${env}`}
                          onClick={() =>
                            setPendingUnscope({ secretId: secret.id, env, key: secret.key })
                          }
                          className="h-5 w-5 shrink-0 text-muted-foreground hover:text-destructive"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                        <span className="flex flex-1 min-w-0 flex-col">
                          <span className="truncate font-mono text-sm font-medium">
                            {secret.key}
                          </span>
                          {secret.namespace && (
                            <span
                              className="truncate font-mono text-[9px] text-muted-foreground/50 opacity-70"
                              title={`namespace: ${secret.namespace}`}
                            >
                              ns:{secret.namespace}
                            </span>
                          )}
                        </span>
                        {/* Issue #4 (applied to repo-secrets-pane too): keep icon visible when row is revealed */}
                        <span className={`flex items-center gap-0.5 transition-opacity ${(revealAll || revealed.has(secret.id)) ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5"
                            aria-label={(revealAll || revealed.has(secret.id)) ? "Hide value" : "Reveal value"}
                            onClick={() => {
                              // Issue #3: pass all repo secret IDs so hiding one row while
                              // revealAll is active shows only the remaining rows across
                              // all environment groups (not just the current env group).
                              toggleReveal(secret.id, repoSecrets.map((s) => s.id));
                            }}
                          >
                            {(revealAll || revealed.has(secret.id)) ? (
                              <EyeOff className="h-3 w-3" />
                            ) : (
                              <Eye className="h-3 w-3" />
                            )}
                          </Button>
                          {secret.tutorial && (
                            <Button
                              variant="ghost"
                              size="icon"
                              className="h-5 w-5"
                              aria-label="View tutorial"
                              onClick={() => {
                                setTutorialSecretId(secret.id);
                                setTutorialOpen(true);
                              }}
                            >
                              <BookOpen className="h-3 w-3" />
                            </Button>
                          )}
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5"
                            aria-label="Edit secret"
                            onClick={() => {
                              setEditing(secret);
                              setDialogOpen(true);
                            }}
                          >
                            <Pencil className="h-3 w-3" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-5 w-5 text-destructive"
                            aria-label="Delete secret"
                            onClick={() => handleDeleteSecret(secret)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <Dialog open={pendingUnscope !== null} onOpenChange={(open) => { if (!open && !isPending) setPendingUnscope(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove secret from repo?</DialogTitle>
            <DialogDescription>
              {pendingUnscope
                ? `Remove "${pendingUnscope.key}" from this repo? This cannot be undone.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingUnscope(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isPending}
              onClick={handleConfirmUnscope}
            >
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={pendingDelete !== null} onOpenChange={(open) => { if (!open && !isPending) setPendingDelete(null); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete secret?</DialogTitle>
            <DialogDescription>
              {pendingDelete
                ? `Permanently delete "${pendingDelete.key}"? This cannot be undone.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setPendingDelete(null)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={isPending}
              onClick={handleConfirmDelete}
            >
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <SecretDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setEditing(null);
        }}
        initialSecret={editing}
        onSubmit={handleEditSubmit}
        busy={isPending}
        defaultNamespace={(() => {
          // Strip non-alphanumeric chars, then strip leading digits so the
          // result always starts with a letter (e.g. "123-service" → "service").
          // Pass undefined instead of an empty string when nothing remains.
          const sanitized = repo.name.toLowerCase().replace(/[^a-z0-9]/g, "").replace(/^[0-9]+/, "");
          return sanitized || undefined;
        })()}
      />
      <ViewTutorialDialog
        open={tutorialOpen}
        onOpenChange={(o) => {
          setTutorialOpen(o);
          if (!o) setTutorialSecretId(null);
        }}
        secret={tutorialSecret}
        onChange={onChange}
      />
    </>
  );
}
