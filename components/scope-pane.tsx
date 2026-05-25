"use client";

import { useTransition } from "react";
import { toast } from "sonner";
import { Grid3X3 } from "lucide-react";
import type { Repo, Secret, VaultData } from "@/lib/vault/schema";
import { Checkbox } from "@/components/ui/checkbox";
import { toggleScopeAction } from "@/app/actions";

export function ScopePane({
  secret,
  repos,
  onChange,
}: {
  secret: Secret | null;
  repos: Repo[];
  onChange: (next: VaultData) => void;
}) {
  const [, startTransition] = useTransition();

  if (!secret) {
    return (
      <section className="flex h-full flex-col items-center justify-center bg-card/10 p-8 text-center">
        <Grid3X3 className="mb-4 h-10 w-10 text-muted-foreground/50" />
        <h2 className="text-sm font-semibold">No secret selected</h2>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          Pick a secret from the middle pane to assign it to repos × environments.
        </p>
      </section>
    );
  }

  if (repos.length === 0) {
    return (
      <section className="flex h-full flex-col items-center justify-center bg-card/10 p-8 text-center">
        <Grid3X3 className="mb-4 h-10 w-10 text-muted-foreground/50" />
        <h2 className="text-sm font-semibold">No repos yet</h2>
        <p className="mt-1 max-w-xs text-xs text-muted-foreground">
          Register a repo on the left to start assigning scopes.
        </p>
      </section>
    );
  }

  function isChecked(repoId: string, env: string): boolean {
    return (
      secret?.scopes.some((sc) => sc.repoId === repoId && sc.env === env) ??
      false
    );
  }

  function handleToggle(repoId: string, env: string, next: boolean) {
    if (!secret) return;
    startTransition(async () => {
      const r = await toggleScopeAction({
        secretId: secret.id,
        repoId,
        env,
        next,
      });
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      onChange(r.data);
    });
  }

  const allEnvs = Array.from(
    new Set(repos.flatMap((r) => r.environments)),
  ).sort();

  return (
    <section className="flex h-full min-h-0 flex-col bg-card/10">
      <header className="shrink-0 border-b border-border px-6 py-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Scope matrix
        </div>
        <div className="mt-1 truncate font-mono text-sm font-medium">
          {secret.key}
        </div>
        <div className="text-xs text-muted-foreground">
          {secret.scopes.length} scope cell{secret.scopes.length === 1 ? "" : "s"} assigned
        </div>
      </header>
      <div className="overflow-auto flex-1 min-h-0 p-6">
        <table className="min-w-full table-fixed border-collapse">
          <thead>
            <tr>
              <th className="sticky left-0 top-0 z-20 bg-card px-3 py-2 text-left text-xs font-medium text-muted-foreground">
                Repo
              </th>
              {allEnvs.map((env) => (
                <th
                  key={env}
                  className="sticky top-0 z-10 bg-card px-3 py-2 text-center text-xs font-medium uppercase tracking-wide text-muted-foreground"
                >
                  {env}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {repos.map((repo) => (
              <tr key={repo.id} className="border-t border-border">
                <td className="sticky left-0 z-10 max-w-[200px] truncate bg-card/20 px-3 py-2 text-sm">
                  <div className="truncate font-medium">{repo.name}</div>
                  <div className="truncate text-xs text-muted-foreground">
                    {repo.path}
                  </div>
                </td>
                {allEnvs.map((env) => {
                  const supported = repo.environments.includes(env);
                  return (
                    <td
                      key={env}
                      className="px-3 py-2 text-center"
                    >
                      {supported ? (
                        <Checkbox
                          checked={isChecked(repo.id, env)}
                          onCheckedChange={(c) =>
                            handleToggle(repo.id, env, c === true)
                          }
                          aria-label={`Toggle ${secret.key} for ${repo.name} / ${env}`}
                        />
                      ) : (
                        <span className="text-xs text-muted-foreground/40">—</span>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
