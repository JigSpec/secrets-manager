"use client";

import { AlertTriangle, ChevronRight } from "lucide-react";

interface NeedsAttentionBannerProps {
  count: number;
  onOpen: () => void;
}

export function NeedsAttentionBanner({ count, onOpen }: NeedsAttentionBannerProps) {
  if (count === 0) return null;
  const plural = count === 1 ? "" : "s";
  const verb = count === 1 ? "needs" : "need";
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-haspopup="dialog"
      aria-label={`${count} secret${plural} ${verb} a value — click to review`}
      className="group flex w-full items-center gap-3 border-b border-amber-200 bg-amber-50/70 px-6 py-2.5 text-left text-sm transition-colors hover:bg-amber-100/80 dark:border-amber-900/40 dark:bg-amber-950/30 dark:hover:bg-amber-950/50"
    >
      <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <span className="font-medium text-amber-900 dark:text-amber-200">
        {count} secret{plural} {verb} a value
      </span>
      <span className="text-amber-700/80 dark:text-amber-300/70">
        — click to review {count === 1 ? "the tutorial" : "tutorials"}
      </span>
      <ChevronRight className="ml-auto h-4 w-4 text-amber-600 transition-transform group-hover:translate-x-0.5 dark:text-amber-400" />
    </button>
  );
}
