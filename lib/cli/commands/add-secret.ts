import path from "node:path";

import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getStringFlag, parseArgs } from "../argv";

register("add-secret", async (argv) => {
  const parsed = parseArgs(argv);
  const key = getStringFlag(parsed, "key");
  const namespace = getStringFlag(parsed, "namespace");
  const variant = getStringFlag(parsed, "variant");
  const valueFromFile = getStringFlag(parsed, "value-from-file");
  const description = getStringFlag(parsed, "description");
  if (!key || !valueFromFile) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "usage: sm add-secret --key KEY [--namespace NS] [--variant V] [--description \"...\"] --value-from-file PATH",
    };
  }
  const valuePath = path.resolve(valueFromFile);
  const args: Record<string, unknown> = { key, valuePath };
  if (namespace !== undefined) args.namespace = namespace;
  if (variant !== undefined) args.variant = variant;
  if (description !== undefined) {
    if (description.length > 500) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: "`description` must be 500 characters or fewer",
      };
    }
    args.description = description;
  }
  return sendCommand({ cmd: "add-secret", args });
});
