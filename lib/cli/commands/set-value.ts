import path from "node:path";

import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getStringFlag, parseArgs } from "../argv";

register("set-value", async (argv) => {
  const parsed = parseArgs(argv);
  const secret = parsed.positionals[0];
  const valueFromFile = getStringFlag(parsed, "value-from-file");
  const description = getStringFlag(parsed, "description");
  if (!secret || !valueFromFile) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "usage: sm set-value <secret> --value-from-file PATH [--description \"...\"]",
    };
  }
  const valuePath = path.resolve(valueFromFile);
  const args: Record<string, unknown> = { secret, valuePath };
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
  return sendCommand({
    cmd: "set-value",
    args,
  });
});
