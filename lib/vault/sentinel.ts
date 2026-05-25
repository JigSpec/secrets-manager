import type { Secret } from "@/lib/vault/schema";

export const SENTINEL_PATTERNS = [
  /^PLACEHOLDER$/i,
  /^TODO$/i,
  /^FIXME$/i,
  /^__SET_VIA_TUTORIAL__$/i,
  /^<.*>$/,
  /^YOUR_.*_HERE$/i,
  /^INSERT_.*_HERE$/i,
  /^CHANGEME$/i,
  /^\[.*\]$/,
];

export type SentinelCheckOptions = {
  /** When true, bypass the sentinel check and always return false. */
  allowSentinel?: boolean;
};

export function isSentinelValue(
  value: string,
  options?: SentinelCheckOptions,
): boolean {
  if (options?.allowSentinel) return false;
  const trimmed = value.trim();
  return SENTINEL_PATTERNS.some((p) => p.test(trimmed));
}

export type EmptyCheckOptions = {
  /** When true, bypass the empty check and always return false. */
  allowEmpty?: boolean;
};

/**
 * Returns true if `value` is a string consisting entirely of whitespace (or is
 * the empty string). Returns false for any non-string input (null, undefined,
 * numbers, etc.) so callers do not need to guard the type before calling.
 */
export function isEmptyValue(
  value: unknown,
  options?: EmptyCheckOptions,
): boolean {
  if (options?.allowEmpty) return false;
  if (typeof value !== "string") return false;
  return value.trim() === "";
}

/**
 * Returns true when a secret needs human attention: it is either in the
 * `awaiting_value` state, holds a well-known sentinel placeholder, or has a
 * blank/whitespace-only value.
 *
 * Centralised here so that workbench.tsx and needs-attention-dialog.tsx
 * (and any future consumers) share exactly one copy of the predicate.
 */
export function needsAttention(s: Secret): boolean {
  return (
    s.status === "awaiting_value" ||
    isSentinelValue(s.value) ||
    isEmptyValue(s.value)
  );
}

export const DOTENVX_RESERVED_KEY_RE = /^DOTENV_(PUBLIC|PRIVATE)_KEY_/;

export function isDotenvxReservedKey(key: string): boolean {
  return DOTENVX_RESERVED_KEY_RE.test(key);
}
