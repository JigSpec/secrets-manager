import { registerHandler, currentSessionData } from "../server";
import { err, ok } from "../protocol";
import { NamespaceSchema } from "../../vault/schema";
import type { SecretMetadata } from "../../vault/schema";

registerHandler("list-secrets", async (args) => {
  let namespace: string | undefined;
  if (args.namespace !== undefined) {
    if (typeof args.namespace !== "string") {
      return err("INVALID_INPUT", "`namespace` must be a string");
    }
    const parsed = NamespaceSchema.safeParse(args.namespace);
    if (!parsed.success) {
      return err(
        "INVALID_INPUT",
        "namespace must be lowercase ascii letters/digits (e.g. 'stripe')",
      );
    }
    namespace = parsed.data;
  }

  const { data } = currentSessionData();
  const filtered = (namespace
    ? data.secrets.filter((s) => s.namespace === namespace)
    : data.secrets
  ).map<SecretMetadata>(({ value: _value, ...rest }) => rest);
  return ok({ secrets: filtered });
});
