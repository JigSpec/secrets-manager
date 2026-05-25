import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { NamespaceSchema } from "../../vault/schema";
import { findSecretOrAmbiguous } from "./_resolve";
import { findScopeConflict } from "../../vault/scope-conflict";

registerHandler("set-namespace", async (args) => {
  if (typeof args.secret !== "string" || args.secret.length === 0) {
    return err("INVALID_INPUT", "`secret` (id or key) is required");
  }
  const isUnset = args.unset === true;
  let namespace: string | undefined;
  if (!isUnset) {
    if (args.namespace === undefined) {
      return err(
        "INVALID_INPUT",
        "either `namespace` or `unset: true` is required",
      );
    }
    if (typeof args.namespace !== "string") {
      return err("INVALID_INPUT", "`namespace` must be a string");
    }
    const parsed = NamespaceSchema.safeParse(args.namespace);
    if (!parsed.success) {
      return err(
        "INVALID_INPUT",
        "namespace must be lowercase ascii letters/digits, max 32 chars (e.g. 'stripe')",
      );
    }
    namespace = parsed.data;
  }

  const { data } = currentSessionData();
  const secretOrAmb = findSecretOrAmbiguous(data, args.secret);
  if (!secretOrAmb) return err("NOT_FOUND", `secret "${args.secret}" not found`);
  if (secretOrAmb === "AMBIGUOUS") {
    return err("AMBIGUOUS", `multiple secrets share key "${args.secret}" — use the secret id instead`);
  }
  const secret = secretOrAmb;

  const updated = isUnset
    ? omitNamespace(secret)
    : { ...secret, namespace: namespace! };

  // Verify the namespace change does not create a scope overlap with any
  // sibling secret that already uses (key, newNamespace).
  const conflict = findScopeConflict(
    data.secrets,
    { key: updated.key, namespace: updated.namespace, scopes: updated.scopes },
    updated.id,
  );
  if (conflict) {
    return err(
      "CONFLICT",
      `changing namespace would create a scope overlap at (${
        conflict.repoId
      }, ${conflict.env}) for key "${updated.key}"${
        updated.namespace ? ` in namespace "${updated.namespace}"` : ""
      }`,
    );
  }

  const secrets = data.secrets.map((s) => (s.id === secret.id ? updated : s));
  await persistData({ ...data, secrets });
  return ok({
    secret: {
      id: updated.id,
      key: updated.key,
      scopes: updated.scopes,
      ...(updated.namespace !== undefined
        ? { namespace: updated.namespace }
        : {}),
    },
  });
});

function omitNamespace<T extends { namespace?: string }>(s: T): T {
  const { namespace: _ns, ...rest } = s;
  return rest as T;
}
