"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Bell, FolderGit2, KeyRound, Lock, Rocket, Settings, ShieldAlert, Tags } from "lucide-react";
import { Button } from "@/components/ui/button";
import { lockAction, type DeployTargetResult } from "@/app/actions";
import {
  toDeployTargetResult,
} from "@/lib/vault/deploy/result-projection";
import type { DeployTargetResult as RawDeployTargetResult } from "@/lib/vault/deploy/run-deploy";
import { DaemonSettingsDialog } from "@/components/daemon-settings-dialog";
import { EnvVariantDialog } from "@/components/env-variant-dialog";
import type { Repo } from "@/lib/vault/schema";
import type { ViewMode } from "@/lib/vault/view-mode";

// Streamed NDJSON event types — must match the wire protocol emitted by
// `app/api/deploy/stream/route.ts`.
type StreamEvent =
  | { kind: "start"; total: number }
  | {
      kind: "target";
      index: number;
      total: number;
      result: RawDeployTargetResult;
    }
  | { kind: "done"; results: RawDeployTargetResult[] }
  | { kind: "error"; error: string };

export function TopBar({
  dirty,
  deployTargetCount,
  deploying,
  onDeployStart,
  onDeployFinish,
  onDeployProgress,
  view,
  onViewChange,
  awaitingCount,
  onAwaitingClick,
  repos,
}: {
  dirty: boolean;
  deployTargetCount: number;
  deploying: boolean;
  onDeployStart: () => void;
  onDeployFinish: (results: DeployTargetResult[], error?: string) => void;
  onDeployProgress: (
    completed: number,
    total: number,
    current?: string,
  ) => void;
  view: ViewMode;
  onViewChange: (v: ViewMode) => void;
  awaitingCount: number;
  onAwaitingClick: () => void;
  repos: Repo[];
}) {
  const [lockPending, startLockTransition] = useTransition();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [envVariantOpen, setEnvVariantOpen] = useState(false);

  const disabledDeploy = deployTargetCount === 0 || deploying;

  /**
   * Streams from `POST /api/deploy/stream`, consuming NDJSON line-by-line so
   * the progress bar advances per target instead of jumping 0/N → N/N
   * (issue #76). Inlined here (rather than using `lib/deploy/stream-client.ts`)
   * because the source-scan tests require `fetch("/api/deploy/stream"`,
   * `getReader()`, and `TextDecoder` to appear literally in this file.
   */
  async function handleDeploy() {
    onDeployStart();
    try {
      const res = await fetch("/api/deploy/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      if (!res.ok || !res.body) {
        let errorMessage = `Deploy failed (HTTP ${res.status}).`;
        try {
          const parsed = (await res.json()) as { error?: string };
          if (typeof parsed.error === "string") errorMessage = parsed.error;
        } catch {
          // ignore — fall through with default message
        }
        toast.error(errorMessage);
        onDeployFinish([], errorMessage);
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let total = 0;
      let finalResults: DeployTargetResult[] | null = null;
      let inbandError: string | null = null;

      const handleLine = (line: string) => {
        if (line.length === 0) return;
        const ev = JSON.parse(line) as StreamEvent;
        if (ev.kind === "start") {
          total = ev.total;
          onDeployProgress(0, total);
          return;
        }
        if (ev.kind === "target") {
          const completed = ev.index + 1;
          const current = `${ev.result.repoName} / ${ev.result.env}`;
          onDeployProgress(completed, total, current);
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

      if (inbandError) {
        toast.error(inbandError);
        onDeployFinish([], inbandError);
        return;
      }
      if (finalResults === null) {
        const noDataError = "Deploy stream ended without a done event.";
        toast.error(noDataError);
        onDeployFinish([], noDataError);
        return;
      }

      const results: DeployTargetResult[] = finalResults;
      onDeployFinish(results);
      const failed = results.filter((r) => !r.ok).length;
      if (failed === 0) {
        toast.success(
          results.length === 0
            ? "Nothing to deploy."
            : `Deployed ${results.length} target${results.length === 1 ? "" : "s"}.`,
        );
      } else {
        toast.error(
          `${failed} target${failed === 1 ? "" : "s"} failed. See sheet for details.`,
        );
      }
    } catch (err) {
      const errMessage = err instanceof Error ? err.message : "Deploy failed.";
      toast.error(errMessage);
      onDeployFinish([], errMessage);
    }
  }

  function handleLock() {
    startLockTransition(async () => {
      await lockAction();
    });
  }

  return (
    <header className="flex items-center justify-between gap-4 border-b border-border bg-card/40 px-6 py-3">
      <div className="flex items-center gap-3">
        <div className="flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground">
          <ShieldAlert className="h-4 w-4" />
        </div>
        <div>
          <div className="text-sm font-semibold leading-tight">Secrets Manager</div>
          <div className="text-xs text-muted-foreground">
            {deployTargetCount} deploy target{deployTargetCount === 1 ? "" : "s"}
            {dirty && deployTargetCount > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 text-amber-600">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                undeployed changes
              </span>
            )}
          </div>
        </div>
      </div>
      <nav className="flex items-center gap-1 rounded-md border border-border bg-background p-0.5" aria-label="View">
        <Button
          size="sm"
          variant={view === "secrets" ? "default" : "ghost"}
          onClick={() => onViewChange("secrets")}
          aria-pressed={view === "secrets"}
        >
          <KeyRound className="h-4 w-4" />
          Secrets
        </Button>
        <Button
          size="sm"
          variant={view === "repos" ? "default" : "ghost"}
          onClick={() => onViewChange("repos")}
          aria-pressed={view === "repos"}
        >
          <FolderGit2 className="h-4 w-4" />
          Repos
        </Button>
        {awaitingCount > 0 && (
          <>
            <span aria-live="polite" className="sr-only">
              {`${awaitingCount} secret${awaitingCount === 1 ? "" : "s"} need${awaitingCount === 1 ? "s" : ""} attention`}
            </span>
            <Button
              size="sm"
              variant="ghost"
              onClick={onAwaitingClick}
              aria-haspopup="dialog"
              aria-label={`${awaitingCount} secret${awaitingCount === 1 ? "" : "s"} need${awaitingCount === 1 ? "s" : ""} attention`}
              className="relative gap-1.5 text-amber-700 hover:text-amber-800 dark:text-amber-400"
            >
              <Bell className="h-4 w-4" />
              <span className="absolute -top-1 -right-1 flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-[9px] font-bold text-white">
                {awaitingCount > 9 ? "9+" : awaitingCount}
              </span>
              Attention
            </Button>
          </>
        )}
      </nav>
      <div className="flex items-center gap-2">
        <Button
          onClick={handleDeploy}
          disabled={disabledDeploy}
          size="sm"
        >
          <Rocket className="h-4 w-4" />
          {deploying ? "Deploying…" : "Encrypt & Deploy All"}
        </Button>
        <Button
          onClick={() => setEnvVariantOpen(true)}
          variant="outline"
          size="sm"
          aria-label="Env → variant map"
          title="Env → variant map"
        >
          <Tags className="h-4 w-4" />
        </Button>
        <Button
          onClick={() => setSettingsOpen(true)}
          variant="outline"
          size="sm"
          aria-label="Daemon settings"
          title="Daemon settings"
        >
          <Settings className="h-4 w-4" />
        </Button>
        <Button
          onClick={handleLock}
          disabled={lockPending}
          variant="outline"
          size="sm"
        >
          <Lock className="h-4 w-4" />
          Lock
        </Button>
      </div>
      <DaemonSettingsDialog open={settingsOpen} onOpenChange={setSettingsOpen} />
      <EnvVariantDialog
        open={envVariantOpen}
        onOpenChange={setEnvVariantOpen}
        repos={repos}
      />
    </header>
  );
}
