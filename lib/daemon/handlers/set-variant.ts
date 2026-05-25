import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { VariantSchema, type Secret, type VaultDataV4 } from "../../vault/schema";
import { findSecretOrAmbiguous } from "./_resolve";
import { planAutoScope, applyAutoScope } from "../../vault/variant/auto-scope";

registerHandler("set-variant", async (args) => {
  if (typeof args.secret !== "string" || args.secret.length === 0) {
    return err("INVALID_INPUT", "`secret` (id or key) is required");
  }
  const isUnset = args.unset === true;
  let variant: string | undefined;
  if (!isUnset && args.variant === undefined) {
    return err(
      "INVALID_INPUT",
      "either `variant` or `unset: true` is required",
    );
  }
  if (isUnset && args.variant !== undefined) {
    return err(
      "INVALID_INPUT",
      "cannot specify both `variant` and `unset`",
    );
  }
  if (!isUnset) {
    if (typeof args.variant !== "string") {
      return err("INVALID_INPUT", "`variant` must be a string");
    }
    const parsed = VariantSchema.safeParse(args.variant);
    if (!parsed.success) {
      return err(
        "INVALID_INPUT",
        "variant must start with a lowercase letter and contain only lowercase letters/digits, max 32 chars",
      );
    }
    variant = parsed.data;
  }

  const { data } = currentSessionData();
  // Pass the new variant to the resolver so an ambiguous bare-key lookup can
  // be disambiguated by the target variant. In `unset` mode `variant` is
  // undefined, so the resolver falls back to its variant-less behaviour.
  const secretOrAmb = findSecretOrAmbiguous(data, args.secret, variant);
  if (!secretOrAmb) return err("NOT_FOUND", `secret "${args.secret}" not found`);
  if (secretOrAmb === "AMBIGUOUS") {
    return err(
      "AMBIGUOUS",
      `multiple secrets share key "${args.secret}" — use the secret id instead`,
    );
  }
  const secret = secretOrAmb;

  let updated: Secret = isUnset
    ? omitVariant(secret)
    : { ...secret, variant: variant! };

  // Identity-triple check: when setting a variant, reject if another secret
  // already occupies the (key, namespace, variant) triple.
  if (!isUnset) {
    const conflict = data.secrets.some(
      (s) =>
        s.id !== secret.id &&
        s.key === updated.key &&
        (s.namespace ?? undefined) === (updated.namespace ?? undefined) &&
        s.variant === updated.variant,
    );
    if (conflict) {
      return err(
        "CONFLICT",
        `secret "${updated.key}"${
          updated.namespace ? ` in namespace "${updated.namespace}"` : ""
        } with variant "${updated.variant}" already exists`,
      );
    }
  }

  let skippedVariants: { repoId: string; env: string; siblingId?: string }[] = [];
  if (!isUnset) {
    // Build a candidateData snapshot that replaces the original secret row with
    // the updated one. This prevents sibling-conflict detection from matching
    // the secret against its own prior variant row (which would fire a false
    // conflict since the secret is being mutated, not a true sibling).
    const candidateData: VaultDataV4 = {
      ...data,
      secrets: data.secrets.map((s) => (s.id === secret.id ? updated : s)),
    };
    // Re-run auto-scope against the candidate state so the secret lands
    // in every cell its new variant resolves to.
    const plan = planAutoScope(updated, candidateData);
    updated = applyAutoScope(updated, plan);
    skippedVariants = plan
      .filter((c): c is Extract<typeof c, { action: "skip-sibling-conflict" }> =>
        c.action === "skip-sibling-conflict",
      )
      .map((c) => ({
        repoId: c.cell.repoId,
        env: c.cell.env,
        ...(c.siblingId !== undefined ? { siblingId: c.siblingId } : {}),
      }));
  }
  // Unset path resolution to Open Question §6.1: preserve existing scopes —
  // never silently de-scope. Users can call unscope_secret explicitly.

  const secrets = data.secrets.map((s) => (s.id === secret.id ? updated : s));
  await persistData({ ...data, secrets });
  return ok({
    secret: {
      id: updated.id,
      key: updated.key,
      scopes: updated.scopes,
      ...(updated.namespace !== undefined ? { namespace: updated.namespace } : {}),
      ...(updated.variant !== undefined ? { variant: updated.variant } : {}),
    },
    ...(skippedVariants.length > 0 ? { skippedVariants } : {}),
  });
});

function omitVariant<T extends { variant?: string }>(s: T): Omit<T, "variant"> {
  const { variant: _v, ...rest } = s;
  return rest;
}
