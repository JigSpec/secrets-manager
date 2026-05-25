"use client";

import { useEffect, useMemo, useState } from "react";
import { AlertTriangle, ChevronLeft, ChevronRight } from "lucide-react";
import type { Secret, VaultData } from "@/lib/vault/schema";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { TutorialCard } from "@/components/tutorial-card";
import { needsAttention } from "@/lib/vault/sentinel";

interface NeedsAttentionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secrets: Secret[];
  onChange: (next: VaultData) => void;
}

function sortAwaiting(secrets: Secret[]): Secret[] {
  return secrets
    .filter(needsAttention)
    .sort((a, b) => {
      const aTime = a.tutorial?.createdAt
        ? new Date(a.tutorial.createdAt).getTime()
        : 0;
      const bTime = b.tutorial?.createdAt
        ? new Date(b.tutorial.createdAt).getTime()
        : 0;
      return bTime - aTime;
    });
}

export function NeedsAttentionDialog({
  open,
  onOpenChange,
  secrets,
  onChange,
}: NeedsAttentionDialogProps) {
  // Snapshot of the awaiting list at the time the dialog was opened.
  // Stable snapshot keeps a card completed mid-session visible in the carousel
  // until the user manually advances or closes — required so the celebration
  // state stays put after the underlying secret loses `awaiting_value` status.
  const [sessionIds, setSessionIds] = useState<string[]>([]);
  const [index, setIndex] = useState(0);
  const [completedIds, setCompletedIds] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!open) return;
    setSessionIds(sortAwaiting(secrets).map((s) => s.id));
    setIndex(0);
    setCompletedIds(new Set());
    // Only resnapshot on open transition.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Resolve snapshot ids against the live secrets array so completed cards
  // pull in their latest data (and so we can detect deletions).
  const liveSessionList = useMemo(() => {
    const byId = new Map(secrets.map((s) => [s.id, s] as const));
    return sessionIds
      .map((id) => byId.get(id))
      .filter((s): s is Secret => s !== undefined);
  }, [sessionIds, secrets]);

  const safeIndex = Math.min(index, Math.max(0, liveSessionList.length - 1));
  const current = liveSessionList[safeIndex];

  function handleCompleted(secretId: string) {
    setCompletedIds((prev) => {
      const next = new Set(prev);
      next.add(secretId);
      return next;
    });
  }

  if (liveSessionList.length === 0) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>All caught up</DialogTitle>
            <DialogDescription>
              No secrets are awaiting a value.
            </DialogDescription>
          </DialogHeader>
          <Button onClick={() => onOpenChange(false)}>Close</Button>
        </DialogContent>
      </Dialog>
    );
  }

  const canPrev = safeIndex > 0;
  const canNext = safeIndex < liveSessionList.length - 1;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 p-0">
        <DialogHeader className="flex flex-row items-center justify-between gap-2 border-b border-border pl-6 pr-12 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <DialogTitle className="text-sm">Needs Your Attention</DialogTitle>
          </div>
          <DialogDescription className="sr-only">
            Step through the tutorials and provide a value for each secret an AI
            agent has requested.
          </DialogDescription>
          <span
            aria-live="polite"
            className="text-xs text-muted-foreground tabular-nums"
          >
            {safeIndex + 1} of {liveSessionList.length}
          </span>
        </DialogHeader>

        <div className="flex-1 overflow-y-auto px-6 py-4">
          {current && (
            <TutorialCard
              key={current.id}
              secret={current}
              onChange={onChange}
              completed={completedIds.has(current.id)}
              onCompleted={handleCompleted}
            />
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border px-6 py-3">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setIndex((i) => Math.max(0, i - 1))}
            disabled={!canPrev}
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          <span className="text-xs text-muted-foreground tabular-nums">
            {completedIds.size} of {liveSessionList.length} done
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              setIndex((i) => Math.min(liveSessionList.length - 1, i + 1))
            }
            disabled={!canNext}
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
