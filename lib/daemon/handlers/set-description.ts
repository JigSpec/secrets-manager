import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { findSecretOrAmbiguous } from "./_resolve";
import type { Secret } from "../../vault/schema";

registerHandler("set-description", async (args) => {
  if (typeof args.secret !== "string" || args.secret.length === 0) {
    return err("INVALID_INPUT", "`secret` (id or key) is required");
  }
  if (args.description === undefined) {
    return err("INVALID_INPUT", "`description` is required (pass empty string \"\" to clear)");
  }
  if (typeof args.description !== "string") {
    return err("INVALID_INPUT", "`description` must be a string");
  }
  if (args.description.length > 500) {
    return err("INVALID_INPUT", "`description` must be 500 characters or fewer");
  }

  const { data } = currentSessionData();
  const secretOrAmb = findSecretOrAmbiguous(data, args.secret);
  if (!secretOrAmb) return err("NOT_FOUND", `secret "${args.secret}" not found`);
  if (secretOrAmb === "AMBIGUOUS") {
    return err("AMBIGUOUS", `multiple secrets share key "${args.secret}" — use the secret id instead`);
  }
  const secret = secretOrAmb;

  const updated: Secret =
    args.description === ""
      ? omitDescription(secret)
      : { ...secret, description: args.description };

  const secrets = data.secrets.map((s) => (s.id === secret.id ? updated : s));
  await persistData({ ...data, secrets });

  return ok({
    secret: {
      id: updated.id,
      key: updated.key,
      scopes: updated.scopes,
      ...(updated.namespace !== undefined ? { namespace: updated.namespace } : {}),
      ...(updated.description !== undefined ? { description: updated.description } : {}),
    },
  });
});

function omitDescription(s: Secret): Secret {
  const { description: _desc, ...rest } = s;
  return rest;
}
