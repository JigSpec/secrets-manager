"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  Folder,
  FolderPlus,
  Pencil,
  Rocket,
  Trash2,
} from "lucide-react";
import type { Repo, VaultData } from "@/lib/vault/schema";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  addRepoAction,
  deleteRepoAction,
  updateRepoAction,
} from "@/app/actions";
import { RepoDialog } from "@/components/repo-dialog";

export function RepoPane({
  repos,
  selectedRepoId,
  onSelect,
  onChange,
  deploying,
  onDeployRepo,
}: {
  repos: Repo[];
  selectedRepoId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (next: VaultData) => void;
  /** True while any deploy is in flight — disables the per-repo Rocket button. */
  deploying: boolean;
  /**
   * Fires when the user clicks the Rocket icon-button on a repo row. The
   * parent (`Workbench`) streams from `/api/deploy/stream` and threads
   * progress events back through the shared deploy sheet. (Issue #76.)
   */
  onDeployRepo: (repoId: string) => void;
}) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Repo | null>(null);
  const [pending, startTransition] = useTransition();

  const sorted = useMemo(
    () => [...repos].sort((a, b) => a.name.localeCompare(b.name)),
    [repos],
  );

  function handleDelete(repo: Repo) {
    if (!confirm(`Delete repo "${repo.name}"? This removes all of its scope assignments.`)) {
      return;
    }
    startTransition(async () => {
      const r = await deleteRepoAction(repo.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      onChange(r.data);
      if (selectedRepoId === repo.id) onSelect(null);
      toast.success(`Removed "${repo.name}".`);
    });
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-card/30">
      <header className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div>
          <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Repos
          </div>
          <div className="text-xs text-muted-foreground">{repos.length} registered</div>
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setEditing(null);
            setDialogOpen(true);
          }}
        >
          <FolderPlus className="h-4 w-4" />
          New
        </Button>
      </header>
      <div className="flex-1 overflow-y-auto min-h-0">
        {sorted.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            <Folder className="mx-auto mb-3 h-8 w-8 opacity-40" />
            No repos yet.
            <br />
            Click <span className="font-medium">New</span> to add one.
          </div>
        ) : (
          <ul className="py-1">
            {sorted.map((repo) => (
              <li key={repo.id}>
                <button
                  type="button"
                  onClick={() => onSelect(repo.id)}
                  className={cn(
                    "group flex w-full items-start gap-3 px-4 py-2 text-left transition-colors hover:bg-accent/60",
                    selectedRepoId === repo.id && "bg-accent",
                  )}
                >
                  <Folder className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-sm font-medium">{repo.name}</div>
                    <div className="truncate text-xs text-muted-foreground">
                      {repo.path}
                    </div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {repo.environments.map((env) => (
                        <span
                          key={env}
                          className="rounded bg-secondary px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-secondary-foreground"
                        >
                          {env}
                        </span>
                      ))}
                    </div>
                  </div>
                  <span className="flex items-start gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      disabled={deploying}
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeployRepo(repo.id);
                      }}
                    >
                      <span
                        role="button"
                        aria-label={`Deploy ${repo.name}`}
                        title="Deploy this repo"
                      >
                        <Rocket className="h-3 w-3" />
                      </span>
                    </Button>
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6"
                      onClick={(e) => {
                        e.stopPropagation();
                        setEditing(repo);
                        setDialogOpen(true);
                      }}
                    >
                      <span role="button" aria-label="Edit repo">
                        <Pencil className="h-3 w-3" />
                      </span>
                    </Button>
                    <Button
                      asChild
                      variant="ghost"
                      size="icon"
                      className="h-6 w-6 text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDelete(repo);
                      }}
                    >
                      <span role="button" aria-label="Delete repo">
                        <Trash2 className="h-3 w-3" />
                      </span>
                    </Button>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <RepoDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) setEditing(null);
        }}
        initialRepo={editing}
        onSubmit={async (form) => {
          if (editing) {
            const r = await updateRepoAction({ id: editing.id, ...form });
            if (!r.ok) return { error: r.error };
            onChange(r.data);
            toast.success(`Updated "${form.name}".`);
            return { ok: true };
          } else {
            const r = await addRepoAction(form);
            if (!r.ok) return { error: r.error };
            onChange(r.data);
            toast.success(`Added "${form.name}".`);
            return { ok: true };
          }
        }}
        busy={pending}
      />
    </section>
  );
}
