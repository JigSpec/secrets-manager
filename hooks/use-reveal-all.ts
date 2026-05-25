"use client";

import { useEffect, useState } from "react";

/**
 * Shared reveal-all logic for secret list components.
 *
 * @param resetKey - When this value changes (e.g. repo.id or filterRepoId),
 *   both `revealAll` and `revealed` are reset to their initial state.
 */
export function useRevealAll(resetKey?: string | null) {
  const [revealAll, setRevealAll] = useState(false);
  const [revealed, setRevealed] = useState<Set<string>>(new Set());

  // Issue #1 (security): reset reveal state whenever the repo context changes.
  useEffect(() => {
    setRevealAll(false);
    setRevealed(new Set());
  }, [resetKey]);

  // Issue #2 (React correctness): call both setters sequentially in the event
  // handler body rather than nesting setRevealed inside the setRevealAll updater.
  function toggleRevealAll() {
    const next = !revealAll;
    setRevealAll(next);
    if (next === false) setRevealed(new Set());
  }

  // Issue #3 (UX/correctness): when hiding an individual row while revealAll is
  // active, turn off revealAll and keep only the rows that were individually
  // revealed minus the one being hidden.
  function toggleReveal(id: string, allIds?: string[]) {
    if (revealAll) {
      // The user is clicking "Hide" on a specific row while revealAll is on.
      // Build the set of all IDs that were individually revealed, add any that
      // were implicitly visible via revealAll (use allIds if provided), then
      // remove the one being hidden.
      const base = allIds ? new Set<string>(allIds) : new Set<string>(revealed);
      base.delete(id);
      setRevealAll(false);
      setRevealed(base);
    } else {
      setRevealed((prev) => {
        const next = new Set(prev);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    }
  }

  return { revealAll, revealed, toggleRevealAll, toggleReveal };
}
