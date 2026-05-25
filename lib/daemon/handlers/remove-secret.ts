import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { findSecret } from "./_resolve";

registerHandler("remove-secret", async (args) => {
  if (typeof args.target !== "string" || args.target.length === 0) {
    return err("INVALID_INPUT", "`target` (secret id or key) is required");
  }
  const { data } = currentSessionData();
  const secret = findSecret(data, args.target);
  if (!secret) return err("NOT_FOUND", `secret "${args.target}" not found`);

  const secrets = data.secrets.filter((s) => s.id !== secret.id);
  await persistData({ ...data, secrets });
  return ok({
    removedSecret: {
      id: secret.id,
      key: secret.key,
      ...(secret.namespace !== undefined ? { namespace: secret.namespace } : {}),
    },
  });
});
