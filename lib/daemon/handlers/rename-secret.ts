import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { SecretKeySchema } from "../../vault/schema";
import { findSecretOrAmbiguous } from "./_resolve";
import { findScopeConflict } from "../../vault/scope-conflict";
import { isDotenvxReservedKey } from "../../vault/sentinel";

registerHandler("rename-secret", async (args) => {
  if (typeof args.secret !== "string" || args.secret.length === 0) {
    return err("INVALID_INPUT", "`secret` (id or key) is required");
  }
  if (typeof args.newKey !== "string" || args.newKey.length === 0) {
    return err("INVALID_INPUT", "`newKey` is required");
  }
  const parsed = SecretKeySchema.safeParse(args.newKey);
  if (!parsed.success) {
    return err(
      "INVALID_INPUT",
      "keys must match /^[A-Z_][A-Z0-9_]*$/ (uppercase only)",
    );
  }
  const newKey = parsed.data;
  if (isDotenvxReservedKey(newKey)) {
    return err(
      "INVALID_INPUT",
      `"${newKey}" is a dotenvx-internal key (matches DOTENV_(PUBLIC|PRIVATE)_KEY_*) and must not be stored in the vault.`,
    );
  }

  const { data } = currentSessionData();
  const secretOrAmb = findSecretOrAmbiguous(data, args.secret);
  if (!secretOrAmb) return err("NOT_FOUND", `secret "${args.secret}" not found`);
  if (secretOrAmb === "AMBIGUOUS") {
    return err("AMBIGUOUS", `multiple secrets share key "${args.secret}" — use the secret id instead`);
  }
  const secret = secretOrAmb;

  if (newKey === secret.key) {
    return ok({
      secret: outboundMeta(secret),
      unchanged: true,
    });
  }

  // Allow the rename only if the renamed secret's current scopes would not
  // overlap with any sibling secret that already uses the new (key, namespace).
  const conflict = findScopeConflict(
    data.secrets,
    { key: newKey, namespace: secret.namespace, scopes: secret.scopes },
    secret.id,
  );
  if (conflict) {
    return err(
      "CONFLICT",
      `renaming to "${newKey}" would create a scope overlap at (${
        conflict.repoId
      }, ${conflict.env})${
        secret.namespace ? ` in namespace "${secret.namespace}"` : ""
      }`,
    );
  }

  const updated = { ...secret, key: newKey };
  const secrets = data.secrets.map((s) => (s.id === secret.id ? updated : s));
  await persistData({ ...data, secrets });
  return ok({ secret: outboundMeta(updated) });
});

function outboundMeta(s: {
  id: string;
  key: string;
  scopes: { repoId: string; env: string }[];
  namespace?: string;
}) {
  const out: Record<string, unknown> = {
    id: s.id,
    key: s.key,
    scopes: s.scopes,
  };
  if (s.namespace !== undefined) out.namespace = s.namespace;
  return out;
}
