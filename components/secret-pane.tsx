"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  BookOpen,
  Clock,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { Repo, Secret, VaultData } from "@/lib/vault/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  addSecretAction,
  deleteSecretAction,
  updateSecretAction,
} from "@/app/actions";
import { SecretDialog } from "@/components/secret-dialog";
import { ViewTutorialDialog } from "@/components/view-tutorial-dialog";
import { useRevealAll } from "@/hooks/use-reveal-all";

export function SecretPane({
  secrets,
  repos,
  selectedSecretId,
  onSelect,
  onChange,
  filterRepoId,
}: {
  secrets: Secret[];
  repos: Repo[];
  selectedSecretId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (next: VaultData) => void;
  filterRepoId?: string | null;
}) {
  const [query, setQuery] = useState("");
  // Issue #1/#2/#3/#5: reveal state managed by shared hook; resets on repo change.
  const { revealAll, revealed, toggleRevealAll, toggleReveal } = useRevealAll(filterRepoId);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<Secret | null>(null);
  const [duplicating, setDuplicating] = useState<Secret | null>(null);
  const [tutorialOpen, setTutorialOpen] = useState(false);
  const [tutorialSecretId, setTutorialSecretId] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const tutorialSecret = tutorialSecretId
    ? (secrets.find((s) => s.id === tutorialSecretId) ?? null)
    : null;

  // If the secret being viewed disappears (deleted via trash, MCP remove_secret,
  // vault re-import), close the dialog and clear the target. Without this the
  // parent state would be latched on a dead id.
  useEffect(() => {
    if (tutorialOpen && tutorialSecretId && !tutorialSecret) {
      setTutorialOpen(false);
      setTutorialSecretId(null);
    }
  }, [tutorialOpen, tutorialSecretId, tutorialSecret]);

  const repoNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of repos) m.set(r.id, r.name);
    return m;
  }, [repos]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();

    let list = filterRepoId
      ? secrets.filter((s) =>
          s.scopes.some((sc) => sc.repoId === filterRepoId),
        )
      : secrets;

    if (q) {
      list = list.filter(
        (s) =>
          s.key.toLowerCase().includes(q) ||
          (s.namespace ?? "").toLowerCase().includes(q),
      );
    }

    return [...list].sort((a, b) => {
      const aNs = a.namespace ?? "";
      const bNs = b.namespace ?? "";
      if (aNs !== bNs) return aNs.localeCompare(bNs);
      return a.key.localeCompare(b.key);
    });
  }, [secrets, query, filterRepoId]);

  // The set of secrets that are scoped to the active filterRepoId (before
  // applying the search query). Used for empty-state message discrimination.
  const repoScopedSecrets = useMemo(
    () =>
      filterRepoId
        ? secrets.filter((s) => s.scopes.some((sc) => sc.repoId === filterRepoId))
        : null,
    [secrets, filterRepoId],
  );

  function handleDelete(secret: Secret) {
    if (!confirm(`Delete secret "${secret.key}"?`)) return;
    startTransition(async () => {
      const r = await deleteSecretAction(secret.id);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      onChange(r.data);
      if (selectedSecretId === secret.id) onSelect(null);
      toast.success(`Removed "${secret.key}".`);
    });
  }

  function emptyStateMessage(): string {
    if (secrets.length === 0) return "No secrets yet. Click New to add one.";
    const q = query.trim();
    if (q) return "No keys match that search.";
    if (filterRepoId) {
      if (!repoScopedSecrets || repoScopedSecrets.length === 0) {
        return "No secrets are scoped to this repo.";
      }
      // repoScopedSecrets has items but the query filtered them all out
      return "No keys match that search.";
    }
    return "No keys match that search.";
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-card/20">
      <header className="shrink-0 space-y-3 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Secrets
            </div>
            <div className="text-xs text-muted-foreground">
              {secrets.length} in vault
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
              variant="outline"
              onClick={() => {
                setEditing(null);
                setDuplicating(null);
                setDialogOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              New
            </Button>
          </div>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search keys…"
            className="pl-8"
          />
        </div>
      </header>
      <div className="flex-1 overflow-y-auto min-h-0">
        {filtered.length === 0 ? (
          <div className="px-4 py-10 text-center text-sm text-muted-foreground">
            <KeyRound className="mx-auto mb-3 h-8 w-8 opacity-40" />
            {emptyStateMessage()}
          </div>
        ) : (
          <ul className="py-1">
            {filtered.map((secret) => {
              const isRevealed = revealAll || revealed.has(secret.id);
              const scopeSummary =
                secret.scopes.length === 0
                  ? "no scopes"
                  : secret.scopes
                      .map(
                        (sc) =>
                          `${repoNameById.get(sc.repoId) ?? "?"}/${sc.env}`,
                      )
                      .join(", ");
              return (
                <li key={secret.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(secret.id)}
                    className={cn(
                      "group flex w-full flex-col gap-1 px-4 py-2 text-left transition-colors hover:bg-accent/60",
                      selectedSecretId === secret.id && "bg-accent",
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="flex min-w-0 items-center gap-1.5">
                        {secret.variant && (
                          <span
                            className="shrink-0 rounded bg-indigo-100 px-1.5 py-0.5 font-mono text-[10px] font-medium uppercase tracking-wide text-indigo-700 dark:bg-indigo-900/40 dark:text-indigo-300"
                            title={`variant: ${secret.variant} — auto-scopes to every (repo, env) where env maps to '${secret.variant}'`}
                          >
                            {secret.variant}
                          </span>
                        )}
                        {secret.status === "awaiting_value" && (
                          <span
                            className="shrink-0 flex items-center gap-0.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:bg-amber-900/40 dark:text-amber-400"
                            title="Awaiting value — placeholder created by set_tutorial"
                          >
                            <Clock className="h-2.5 w-2.5" />
                            awaiting value
                          </span>
                        )}
                        <span className="truncate font-mono text-sm font-medium">
                          {secret.key}
                        </span>
                      </span>
                      {/* Issue #4: keep eye icon always visible when row is revealed */}
                      <span className={cn("flex items-center gap-0.5 transition-opacity", isRevealed ? "opacity-100" : "opacity-0 group-hover:opacity-100")}>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label={isRevealed ? "Hide value" : "Reveal value"}
                          title={isRevealed ? "Hide value" : "Reveal value"}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Issue #3: pass all visible IDs so hiding one row while
                            // revealAll is active shows only the remaining rows.
                            toggleReveal(secret.id, filtered.map((s) => s.id));
                          }}
                        >
                          {isRevealed ? (
                            <EyeOff className="h-3 w-3" />
                          ) : (
                            <Eye className="h-3 w-3" />
                          )}
                        </Button>
                        {secret.tutorial && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6"
                            aria-label="View tutorial"
                            title="View tutorial"
                            onClick={(e) => {
                              e.stopPropagation();
                              setTutorialSecretId(secret.id);
                              setTutorialOpen(true);
                            }}
                          >
                            <BookOpen className="h-3 w-3" />
                          </Button>
                        )}
                        {/* setEditing(null) and setDuplicating/setDialogOpen must stay
                            co-located: both must be set before opening to ensure the
                            dialog opens in the correct mode (duplicate, not edit). */}
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label="Duplicate secret"
                          title="Duplicate secret"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(null);
                            setDuplicating(secret);
                            setDialogOpen(true);
                          }}
                        >
                          <Copy className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          aria-label="Edit secret"
                          title="Edit secret"
                          onClick={(e) => {
                            e.stopPropagation();
                            setEditing(secret);
                            setDialogOpen(true);
                          }}
                        >
                          <Pencil className="h-3 w-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6 text-destructive"
                          aria-label="Delete secret"
                          title="Delete secret"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDelete(secret);
                          }}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </span>
                    </div>
                    <div className="truncate font-mono text-xs text-muted-foreground">
                      {isRevealed ? secret.value || <em>empty</em> : "•••••••••"}
                    </div>
                    {secret.namespace && (
                      <div
                        className="truncate font-mono text-[9px] text-muted-foreground/50 opacity-70"
                        title={`namespace: ${secret.namespace} (internal disambiguator only — deploys as ${secret.key})`}
                      >
                        ns:{secret.namespace}
                      </div>
                    )}
                    {secret.description && (
                      <div className="truncate text-[10px] text-muted-foreground/80">
                        {secret.description}
                      </div>
                    )}
                    <div className="truncate text-[10px] uppercase tracking-wide text-muted-foreground/80">
                      {scopeSummary}
                    </div>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      <SecretDialog
        open={dialogOpen}
        onOpenChange={(o) => {
          setDialogOpen(o);
          if (!o) {
            setEditing(null);
            setDuplicating(null);
          }
        }}
        initialSecret={editing}
        duplicateSource={duplicating}
        // defaultNamespace intentionally omitted: SecretPane has no repo context.
        onSubmit={async (form) => {
          const labelParts: string[] = [];
          if (form.namespace) labelParts.push(`[${form.namespace}]`);
          labelParts.push(form.key);
          if (form.variant) labelParts.push(`{${form.variant}}`);
          const label = labelParts.join(" ");
          // Surface sibling-conflict skips to the operator: planAutoScope
          // intentionally drops cells already owned by a sibling with the
          // same key+namespace but a different variant. The toast tells
          // the operator which cells were skipped so they can decide
          // whether to re-point or leave the sibling.
          const warnSkipped = (
            skippedVariants: { repoId: string; env: string }[] | undefined,
          ) => {
            if (!skippedVariants || skippedVariants.length === 0) return;
            const cells = skippedVariants
              .map((sv) => {
                const repoName =
                  repos.find((r) => r.id === sv.repoId)?.name ?? sv.repoId;
                return `${repoName}/${sv.env}`;
              })
              .join(", ");
            toast.warning(
              `Skipped ${skippedVariants.length} cell(s) due to sibling conflict: ${cells}. Re-point or remove the sibling to claim them.`,
            );
          };
          if (editing) {
            const r = await updateSecretAction({ id: editing.id, ...form });
            if (!r.ok) return { error: r.error };
            onChange(r.data);
            toast.success(`Updated "${label}".`);
            warnSkipped(r.skippedVariants);
            return { ok: true };
          } else {
            const r = await addSecretAction(form);
            if (!r.ok) return { error: r.error };
            onChange(r.data);
            toast.success(`Added "${label}".`);
            warnSkipped(r.skippedVariants);
            return { ok: true };
          }
        }}
        busy={pending}
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
    </section>
  );
}
