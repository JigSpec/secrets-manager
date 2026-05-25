import type { Tutorial } from "@/lib/vault/schema";

const STALE_THRESHOLD_DAYS = 90;

export function isTutorialStale(tutorial: Tutorial): boolean {
  if (tutorial.mayBeStale === true) return true;
  const created = new Date(tutorial.createdAt);
  const now = new Date();
  const ageDays = (now.getTime() - created.getTime()) / (1000 * 60 * 60 * 24);
  return ageDays > STALE_THRESHOLD_DAYS;
}
