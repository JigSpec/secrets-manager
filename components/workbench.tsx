"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { FolderGit2 } from "lucide-react";
import type { Repo, Secret, VaultData } from "@/lib/vault/schema";
import { getThirdColumnMode, shouldClearSecret, shouldClearRepo, type ViewMode } from "@/lib/vault/view-mode";
import { TopBar } from "@/components/topbar";
import { RepoPane } from "@/components/repo-pane";
import { SecretPane } from "@/components/secret-pane";
import { ScopePane } from "@/components/scope-pane";
import { RepoSecretsPane } from "@/components/repo-secrets-pane";
import { DeploySheet, type DeployProgress } from "@/components/deploy-sheet";
import type { DeployTargetResult } from "@/app/actions";
import { importDroppedVaultAction } from "@/app/actions";
import { streamDeploy } from "@/lib/deploy/stream-client";
import DropZone from "@/components/drop-zone";
import { NeedsAttentionBanner } from "@/components/needs-attention-banner";
import { NeedsAttentionDialog } from "@/components/needs-attention-dialog";
import { needsAttention } from "@/lib/vault/sentinel";

export function Workbench({ initialData }: { initialData: VaultData }) {
  const [data, setData] = useState<VaultData>(initialData);
  const [selectedRepoId, setSelectedRepoId] = useState<string | null>(null);
  const [selectedSecretId, setSelectedSecretId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>("secrets");
  const [deployOpen, setDeployOpen] = useState(false);
  const [deployResults, setDeployResults] = useState<DeployTargetResult[] | null>(
    null,
  );
  const [deploying, setDeploying] = useState(false);
  const [deployError, setDeployError] = useState<string | null>(null);
  const [needsAttentionOpen, setNeedsAttentionOpen] = useState(false);
  const [progress, setProgress] = useState<DeployProgress>({
    completed: 0,
    total: 0,
  });

  // The "dirty since last deploy" indicator: any vault revision after the last
  // successful deploy means there's unsynced state.
  const [lastDeployedRevision, setLastDeployedRevision] = useState<number>(0);
  const [revision, setRevision] = useState<number>(0);
  // Ref kept in sync with `revision` so that onDeployFinish (dep array [])
  // can read the up-to-date value without closing over a stale revision or
  // nesting a setState call inside another setState updater (React anti-pattern).
  const revisionRef = useRef(revision);
  useEffect(() => { revisionRef.current = revision; }, [revision]);

  const selectedRepo: Repo | null = useMemo(
    () => data.repos.find((r) => r.id === selectedRepoId) ?? null,
    [data.repos, selectedRepoId],
  );
  const selectedSecret: Secret | null = useMemo(
    () => data.secrets.find((s) => s.id === selectedSecretId) ?? null,
    [data.secrets, selectedSecretId],
  );

  const applyData = useCallback((next: VaultData) => {
    setData(next);
    setRevision((r) => r + 1);
  }, []);

  const handleRepoSelect = useCallback((id: string | null) => {
    setSelectedRepoId(id);
    setView("repos");
  }, []);

  const handleSecretSelect = useCallback((id: string | null) => {
    setSelectedSecretId(id);
    setView("secrets");
  }, []);

  const handleFileDrop = useCallback(
    async (content: string, fileName: string) => {
      const result = await importDroppedVaultAction(content);
      if (result.ok) {
        applyData(result.data);
      } else {
        console.error(`Failed to import dropped vault "${fileName}":`, result.error);
      }
    },
    [applyData],
  );

  const deployTargetCount = useMemo(() => {
    const set = new Set<string>();
    for (const s of data.secrets) {
      for (const sc of s.scopes) {
        set.add(`${sc.repoId}::${sc.env}`);
      }
    }
    return set.size;
  }, [data.secrets]);

  const awaitingCount = useMemo(
    () => data.secrets.filter(needsAttention).length,
    [data.secrets],
  );

  const onDeployStart = useCallback((total: number, current?: string) => {
    setDeployOpen(true);
    setDeploying(true);
    setDeployResults(null);
    setDeployError(null);
    setProgress({ completed: 0, total, current });
  }, []);

  /**
   * Wired to the per-target streamed NDJSON event handler — advances the
   * deploy progress bar one tick at a time instead of jumping 0/N → N/N
   * (issue #76). The streamed values come from `runDeploy.onTarget`.
   *
   * The server's `start` event arrives with no `current`, which would wipe
   * the repo-name label that `onDeployStart` just set on a per-repo deploy.
   * To avoid the brief "0/N with no label" flash we preserve the existing
   * `current` whenever the new event doesn't carry one (issue #88, comment
   * 3254830714).
   */
  const onDeployProgress = useCallback(
    (completed: number, total: number, current?: string) => {
      setProgress((prev) => ({
        completed,
        total,
        current: current ?? prev.current,
      }));
    },
    [],
  );

  const onDeployFinish = useCallback(
    (results: DeployTargetResult[], error?: string) => {
      setDeployResults(results);
      setDeploying(false);
      setDeployError(error ?? null);
      // Defensive terminal sync — the per-target onDeployProgress events
      // should already have driven `completed` up to `total`, but if a stream
      // ended early we snap to 100% so the bar matches the final results.
      setProgress((p) => ({ ...p, completed: p.total, current: undefined }));
      if (results.every((r) => r.ok)) {
        // Use revisionRef to read the current revision without closing over the
        // stale `revision` value and without nesting setState inside a setState
        // updater (which React forbids — updaters must be pure/side-effect-free).
        setLastDeployedRevision((_prev) => revisionRef.current);
      }
    },
    [],
  );

  /**
   * Per-repo deploy entry-point fired by the discoverable Rocket icon-button
   * next to each repo row in the RepoPane. Streams from /api/deploy/stream
   * with the repo's id so the parent sheet progresses tick-by-tick.
   */
  const handleDeployRepo = useCallback(
    async (repoId: string) => {
      const repo = data.repos.find((r) => r.id === repoId);
      if (!repo) return;
      const targetCount = (() => {
        const set = new Set<string>();
        for (const s of data.secrets) {
          for (const sc of s.scopes) {
            if (sc.repoId === repoId) set.add(sc.env);
          }
        }
        return set.size;
      })();
      onDeployStart(targetCount, repo.name);
      // Defensive try/catch: even after stream-client's parser is hardened,
      // the underlying fetch/Response can still throw (network teardown
      // mid-stream, etc). Without this catch `deploying` stays `true` and
      // the sheet hangs forever (issue #88, comment 3254830717).
      try {
        const r = await streamDeploy(
          { repoId },
          { onProgress: onDeployProgress },
        );
        if (!r.ok) {
          toast.error(r.error);
          onDeployFinish([], r.error);
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
        const errMsg = err instanceof Error ? err.message : "Deploy failed.";
        toast.error(errMsg);
        onDeployFinish([], errMsg);
      }
    },
    [data, onDeployStart, onDeployFinish, onDeployProgress],
  );

  const isDirty = revision > lastDeployedRevision;

  function renderThirdColumn() {
    const mode = getThirdColumnMode(view, selectedSecretId, selectedRepoId);
    if (mode === "scope") {
      return (
        <ScopePane
          secret={selectedSecret}
          repos={data.repos}
          onChange={applyData}
        />
      );
    }
    if (mode === "repo-secrets" && selectedRepo) {
      return (
        <RepoSecretsPane
          key={selectedRepo.id}
          repo={selectedRepo}
          secrets={data.secrets}
          onChange={applyData}
          deploying={deploying}
          onDeployStart={onDeployStart}
          onDeployFinish={onDeployFinish}
          onDeployProgress={onDeployProgress}
        />
      );
    }
    // Placeholder for: no repo selected, or stale selectedRepoId pointing to a deleted repo.
    return (
      <section className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
        <FolderGit2 className="h-10 w-10 opacity-40" />
        <p className="text-sm">No repo selected — Pick a repo from the left pane to view its secrets.</p>
      </section>
    );
  }

  return (
    <DropZone onFileDrop={handleFileDrop} className="flex flex-1 flex-col min-h-0">
      <TopBar
        dirty={isDirty}
        deployTargetCount={deployTargetCount}
        deploying={deploying}
        onDeployStart={() => onDeployStart(deployTargetCount)}
        onDeployFinish={onDeployFinish}
        onDeployProgress={onDeployProgress}
        view={view}
        onViewChange={(v) => {
          setView(v);
          if (shouldClearSecret(v)) setSelectedSecretId(null);
          if (shouldClearRepo(v)) setSelectedRepoId(null);
        }}
        awaitingCount={awaitingCount}
        onAwaitingClick={() => setNeedsAttentionOpen(true)}
        repos={data.repos}
      />
      <NeedsAttentionBanner
        count={awaitingCount}
        onOpen={() => setNeedsAttentionOpen(true)}
      />
      <div className="grid flex-1 grid-cols-[280px_360px_1fr] divide-x divide-border overflow-hidden">
        <RepoPane
          repos={data.repos}
          selectedRepoId={selectedRepoId}
          onSelect={handleRepoSelect}
          onChange={applyData}
          deploying={deploying}
          onDeployRepo={handleDeployRepo}
        />
        <SecretPane
          secrets={data.secrets}
          repos={data.repos}
          selectedSecretId={selectedSecretId}
          onSelect={handleSecretSelect}
          onChange={applyData}
          filterRepoId={view === "repos" ? selectedRepoId : null}
        />
        {renderThirdColumn()}
      </div>
      <DeploySheet
        open={deployOpen}
        onOpenChange={setDeployOpen}
        results={deployResults}
        deploying={deploying}
        progress={progress}
        deployError={deployError}
      />
      <NeedsAttentionDialog
        open={needsAttentionOpen}
        onOpenChange={setNeedsAttentionOpen}
        secrets={data.secrets}
        onChange={applyData}
      />
    </DropZone>
  );
}
