import { registerHandler, currentSessionData } from "../server";
import { err, ok } from "../protocol";
import { fingerprint } from "../../import/value-hash";
import type { SecretMetadata } from "../../vault/schema";
import { isTutorialStale } from "../../vault/tutorial-staleness";

/**
 * Resolve a secret by id or key. Returns the secret's metadata (no value)
 * plus an optional `valueFingerprint` — the first 16 hex chars of
 * SHA-256(value), with the low-entropy filter applied. Plaintext stays in
 * the daemon.
 */
registerHandler("describe-secret", async (args) => {
  if (typeof args.id !== "string" || args.id.length === 0) {
    return err("INVALID_INPUT", "`id` is required (secret id or key)");
  }
  const { data } = currentSessionData();
  const needle = args.id;
  const match =
    data.secrets.find((s) => s.id === needle) ??
    data.secrets.find((s) => s.key === needle);
  if (!match) {
    return err("NOT_FOUND", `no secret with id or key "${needle}"`);
  }
  const { value, ...rest } = match;
  const fp = fingerprint(value);
  const out: SecretMetadata & { valueFingerprint?: string; tutorialIsStale?: boolean } = rest;
  if (fp) out.valueFingerprint = fp;
  if (match.tutorial) {
    out.tutorialIsStale = isTutorialStale(match.tutorial);
  }
  return ok({ secret: out });
});
