import { createHash } from "node:crypto";

export const FINGERPRINT_MIN_LENGTH = 20;
export const FINGERPRINT_MIN_ENTROPY_BITS_PER_CHAR = 3.5;
export const FINGERPRINT_HEX_CHARS = 16;

/**
 * Shannon entropy in bits/char of an arbitrary string. Returns 0 for empty
 * input. Plays well with both ASCII and unicode (counts code units).
 */
export function shannonEntropy(s: string): number {
  if (s.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  const n = s.length;
  let h = 0;
  for (const c of counts.values()) {
    const p = c / n;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Deterministic short fingerprint of a value: first 16 hex chars of
 * SHA-256(value). Returns `null` if the value is "low-signal":
 *
 *  - length < 20, or
 *  - Shannon entropy ≤ 3.5 bits/char.
 *
 * The filter prevents low-entropy fingerprints (a few hundred unique words
 * like "password", "secret", "true") from acting as stable labels users
 * could grep for.
 */
export function fingerprint(value: string): string | null {
  if (value.length < FINGERPRINT_MIN_LENGTH) return null;
  if (shannonEntropy(value) <= FINGERPRINT_MIN_ENTROPY_BITS_PER_CHAR) return null;
  const h = createHash("sha256").update(value, "utf8").digest("hex");
  return h.slice(0, FINGERPRINT_HEX_CHARS);
}
