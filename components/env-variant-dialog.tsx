"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  envVariantListAction,
  envVariantSetAction,
  envVariantUnsetAction,
  type EnvVariantMapView,
} from "@/app/actions";
import type { Repo } from "@/lib/vault/schema";

export function EnvVariantDialog({
  open,
  onOpenChange,
  repos,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  repos: Repo[];
}) {
  const [view, setView] = useState<EnvVariantMapView | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  // Global add-row form state
  const [globalEnv, setGlobalEnv] = useState("");
  const [globalVariant, setGlobalVariant] = useState("");

  // Per-repo add-row form state
  const [repoId, setRepoId] = useState<string>("");
  const [repoEnv, setRepoEnv] = useState("");
  const [repoVariant, setRepoVariant] = useState("");

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    void envVariantListAction()
      .then((r) => {
        if (!r.ok) {
          setError(r.error);
          setView(null);
        } else {
          setView(r.data);
        }
      })
      .finally(() => setLoading(false));
  }, [open]);

  // Default the repo picker to the first repo when data arrives.
  useEffect(() => {
    if (repos.length > 0 && repoId === "") setRepoId(repos[0]!.id);
  }, [repos, repoId]);

  const repoNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of repos) m.set(r.id, r.name);
    return m;
  }, [repos]);

  function applyView(next: EnvVariantMapView) {
    setView(next);
  }

  function handleSetGlobal(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const env = globalEnv.trim();
    const variant = globalVariant.trim();
    if (!env || !variant) {
      setError("Both env and variant are required.");
      return;
    }
    startTransition(async () => {
      const r = await envVariantSetAction({ env, variant });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      applyView(r.data);
      setGlobalEnv("");
      setGlobalVariant("");
      toast.success(`Set global ${env} → ${variant}.`);
    });
  }

  function handleSetRepo(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const env = repoEnv.trim();
    const variant = repoVariant.trim();
    if (!repoId) {
      setError("Select a repo.");
      return;
    }
    if (!env || !variant) {
      setError("Both env and variant are required.");
      return;
    }
    startTransition(async () => {
      const r = await envVariantSetAction({ env, variant, repo: repoId });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      applyView(r.data);
      setRepoEnv("");
      setRepoVariant("");
      const label = repoNameById.get(repoId) ?? repoId;
      toast.success(`Set ${label} / ${env} → ${variant}.`);
    });
  }

  function handleUnsetGlobal(env: string) {
    startTransition(async () => {
      const r = await envVariantUnsetAction({ env });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      applyView(r.data);
      toast.success(`Removed global override for ${env}.`);
    });
  }

  function handleUnsetRepo(repo: string, env: string) {
    startTransition(async () => {
      const r = await envVariantUnsetAction({ env, repo });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      applyView(r.data);
      const label = repoNameById.get(repo) ?? repo;
      toast.success(`Removed ${label} / ${env} override.`);
    });
  }

  function handleRestoreDefaults() {
    if (!view) return;
    if (
      !confirm(
        "Restore defaults? This removes every global and per-repo override. " +
          "The built-in default map will apply.",
      )
    ) {
      return;
    }
    startTransition(async () => {
      const all: Array<{ env: string; repo?: string }> = [];
      for (const env of Object.keys(view.envVariantMap.global)) {
        all.push({ env });
      }
      for (const repo of Object.keys(view.envVariantMap.repos)) {
        for (const env of Object.keys(view.envVariantMap.repos[repo] ?? {})) {
          all.push({ env, repo });
        }
      }
      let latest: EnvVariantMapView | null = null;
      for (const item of all) {
        const r = await envVariantUnsetAction(item);
        if (!r.ok) {
          toast.error(r.error);
          return;
        }
        latest = r.data;
      }
      if (latest) applyView(latest);
      toast.success("Restored defaults.");
    });
  }

  const globalEntries = view
    ? Object.entries(view.envVariantMap.global).sort(([a], [b]) =>
        a.localeCompare(b),
      )
    : [];
  const repoEntries = view
    ? Object.entries(view.envVariantMap.repos).flatMap(([rid, envs]) =>
        Object.entries(envs ?? {}).map(([env, variant]) => ({
          repo: rid,
          env,
          variant,
        })),
      )
    : [];
  const defaultEntries = view
    ? Object.entries(view.defaults).sort(([a], [b]) => a.localeCompare(b))
    : [];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Env → variant map</DialogTitle>
          <DialogDescription>
            Map environment names (e.g. <code className="font-mono">dev</code>,{" "}
            <code className="font-mono">production</code>) to variant tags (e.g.{" "}
            <code className="font-mono">test</code>,{" "}
            <code className="font-mono">live</code>). When you add a secret with
            a variant, the daemon auto-scopes it into every (repo, env) cell
            whose env resolves to that variant via this map. Per-repo overrides
            win over global mappings. If both are missing, the built-in
            defaults apply.
          </DialogDescription>
        </DialogHeader>

        {loading || !view ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            {error ? error : "Loading…"}
          </div>
        ) : (
          <div className="space-y-6">
            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </div>
            )}

            {/* Built-in defaults reference */}
            <section className="rounded-md border border-border bg-muted/30 p-3 text-xs">
              <div className="mb-2 font-medium text-foreground">
                Built-in defaults (used when no override matches)
              </div>
              <div className="flex flex-wrap gap-1.5">
                {defaultEntries.map(([env, variant]) => (
                  <span
                    key={env}
                    className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                  >
                    {env} → {variant}
                  </span>
                ))}
              </div>
            </section>

            {/* Global overrides */}
            <section className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Global overrides
              </div>
              {globalEntries.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No global overrides set — the built-in defaults apply.
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {globalEntries.map(([env, variant]) => (
                    <li
                      key={env}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span className="font-mono">
                        <span className="text-foreground">{env}</span>
                        <span className="text-muted-foreground">{" → "}</span>
                        <span className="text-indigo-700 dark:text-indigo-300">
                          {variant}
                        </span>
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => handleUnsetGlobal(env)}
                        disabled={pending}
                        aria-label={`Remove global override for ${env}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              <form
                onSubmit={handleSetGlobal}
                className="flex flex-wrap items-end gap-2"
              >
                <div className="flex-1 min-w-[120px] space-y-1">
                  <Label htmlFor="env-variant-global-env" className="text-xs">
                    Env name
                  </Label>
                  <Input
                    id="env-variant-global-env"
                    value={globalEnv}
                    onChange={(e) => setGlobalEnv(e.target.value)}
                    placeholder="dev"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <div className="flex-1 min-w-[120px] space-y-1">
                  <Label htmlFor="env-variant-global-variant" className="text-xs">
                    Variant
                  </Label>
                  <Input
                    id="env-variant-global-variant"
                    value={globalVariant}
                    onChange={(e) =>
                      setGlobalVariant(e.target.value.toLowerCase())
                    }
                    placeholder="test"
                    className="font-mono"
                    autoComplete="off"
                    spellCheck={false}
                  />
                </div>
                <Button type="submit" size="sm" disabled={pending}>
                  Add global mapping
                </Button>
              </form>
            </section>

            {/* Per-repo overrides */}
            <section className="space-y-2">
              <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Per-repo overrides
              </div>
              {repoEntries.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  No per-repo overrides set.
                </p>
              ) : (
                <ul className="divide-y divide-border rounded-md border border-border">
                  {repoEntries.map(({ repo, env, variant }) => (
                    <li
                      key={`${repo}::${env}`}
                      className="flex items-center justify-between gap-2 px-3 py-2 text-sm"
                    >
                      <span className="font-mono">
                        <span className="text-muted-foreground">
                          {repoNameById.get(repo) ?? repo}
                          {" / "}
                        </span>
                        <span className="text-foreground">{env}</span>
                        <span className="text-muted-foreground">{" → "}</span>
                        <span className="text-indigo-700 dark:text-indigo-300">
                          {variant}
                        </span>
                      </span>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => handleUnsetRepo(repo, env)}
                        disabled={pending}
                        aria-label={`Remove ${env} override for ${repoNameById.get(repo) ?? repo}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </li>
                  ))}
                </ul>
              )}
              {repos.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  Register a repo to set per-repo overrides.
                </p>
              ) : (
                <form
                  onSubmit={handleSetRepo}
                  className="flex flex-wrap items-end gap-2"
                >
                  <div className="flex-1 min-w-[120px] space-y-1">
                    <Label htmlFor="env-variant-repo" className="text-xs">
                      Repo
                    </Label>
                    <select
                      id="env-variant-repo"
                      value={repoId}
                      onChange={(e) => setRepoId(e.target.value)}
                      className="h-9 w-full rounded-md border border-input bg-background px-2 py-1 text-sm"
                    >
                      {repos.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="flex-1 min-w-[120px] space-y-1">
                    <Label htmlFor="env-variant-repo-env" className="text-xs">
                      Env name
                    </Label>
                    <Input
                      id="env-variant-repo-env"
                      value={repoEnv}
                      onChange={(e) => setRepoEnv(e.target.value)}
                      placeholder="qa"
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <div className="flex-1 min-w-[120px] space-y-1">
                    <Label
                      htmlFor="env-variant-repo-variant"
                      className="text-xs"
                    >
                      Variant
                    </Label>
                    <Input
                      id="env-variant-repo-variant"
                      value={repoVariant}
                      onChange={(e) =>
                        setRepoVariant(e.target.value.toLowerCase())
                      }
                      placeholder="test"
                      className="font-mono"
                      autoComplete="off"
                      spellCheck={false}
                    />
                  </div>
                  <Button type="submit" size="sm" disabled={pending}>
                    Add per-repo mapping
                  </Button>
                </form>
              )}
            </section>
          </div>
        )}

        <DialogFooter className="gap-2 sm:gap-2">
          {view && (globalEntries.length > 0 || repoEntries.length > 0) && (
            <Button
              type="button"
              variant="outline"
              onClick={handleRestoreDefaults}
              disabled={pending}
              className="mr-auto"
            >
              Restore defaults
            </Button>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
