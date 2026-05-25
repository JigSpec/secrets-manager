import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { findRepo, findSecret } from "./_resolve";

registerHandler("unscope", async (args) => {
  if (typeof args.secret !== "string" || args.secret.length === 0) {
    return err("INVALID_INPUT", "`secret` (id or key) is required");
  }
  if (typeof args.repo !== "string" || args.repo.length === 0) {
    return err("INVALID_INPUT", "`repo` (id or name) is required");
  }
  if (typeof args.env !== "string" || args.env.length === 0) {
    return err("INVALID_INPUT", "`env` is required");
  }

  const { data } = currentSessionData();
  const secret = findSecret(data, args.secret);
  if (!secret) return err("NOT_FOUND", `secret "${args.secret}" not found`);
  const repo = findRepo(data, args.repo);
  if (!repo) return err("NOT_FOUND", `repo "${args.repo}" not found`);

  const filtered = secret.scopes.filter(
    (sc) => !(sc.repoId === repo.id && sc.env === args.env),
  );
  if (filtered.length === secret.scopes.length) {
    return ok({
      secret: {
        id: secret.id,
        key: secret.key,
        scopes: secret.scopes,
        ...(secret.namespace !== undefined ? { namespace: secret.namespace } : {}),
      },
      unchanged: true,
    });
  }
  const updated = { ...secret, scopes: filtered };
  const secrets = data.secrets.map((s) => (s.id === secret.id ? updated : s));
  await persistData({ ...data, secrets });
  return ok({
    secret: {
      id: updated.id,
      key: updated.key,
      scopes: updated.scopes,
      ...(updated.namespace !== undefined ? { namespace: updated.namespace } : {}),
    },
  });
});
