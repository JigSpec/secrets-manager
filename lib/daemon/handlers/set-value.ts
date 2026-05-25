import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { readValueFromFile } from "../value-handoff";
import { findSecret } from "./_resolve";
import { classifySecret } from "../../vault/classify";
import { isSentinelValue } from "../../vault/sentinel";

registerHandler("set-value", async (args) => {
  if (typeof args.secret !== "string" || args.secret.length === 0) {
    return err("INVALID_INPUT", "`secret` (id or key) is required");
  }
  if (typeof args.valuePath !== "string" || args.valuePath.length === 0) {
    return err("INVALID_INPUT", "`valuePath` (file containing the new value) is required");
  }

  const { data } = currentSessionData();
  const secret = findSecret(data, args.secret);
  if (!secret) return err("NOT_FOUND", `secret "${args.secret}" not found`);

  let handoff;
  try {
    handoff = await readValueFromFile(args.valuePath);
  } catch (e) {
    return err(
      "INVALID_INPUT",
      `could not read value file: ${(e as Error).message ?? "unknown error"}`,
    );
  }

  if (isSentinelValue(handoff.value)) {
    await handoff.unlink();
    return err(
      "INVALID_INPUT",
      "value appears to be a placeholder sentinel (e.g. TODO, PLACEHOLDER, <YOUR_KEY>). Use `set_tutorial` to create an awaiting_value placeholder instead.",
    );
  }

  if (args.description !== undefined) {
    if (typeof args.description !== "string") {
      return err("INVALID_INPUT", "`description` must be a string");
    }
    if (args.description.length > 500) {
      return err("INVALID_INPUT", "`description` must be 500 characters or fewer");
    }
  }

  try {
    const flavor = classifySecret(handoff.value);
    const { status, ...secretWithoutStatus } = secret;
    const updated = {
      ...secretWithoutStatus,
      ...(status !== "awaiting_value" && status !== undefined ? { status } : {}),
      value: handoff.value,
      flavor,
    };
    if (args.description !== undefined) {
      if (args.description === "") {
        delete updated.description;
      } else {
        updated.description = args.description;
      }
    }
    const secrets = data.secrets.map((s) => (s.id === secret.id ? updated : s));
    await persistData({ ...data, secrets });
    return ok({
      secret: {
        id: updated.id,
        key: updated.key,
        scopes: updated.scopes,
        flavor: updated.flavor,
        ...(updated.namespace !== undefined ? { namespace: updated.namespace } : {}),
        ...(updated.description !== undefined ? { description: updated.description } : {}),
      },
    });
  } finally {
    await handoff.unlink();
  }
});
