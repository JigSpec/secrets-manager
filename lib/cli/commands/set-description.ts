import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getBoolFlag, getStringFlag, parseArgs } from "../argv";

register("set-description", async (argv) => {
  const parsed = parseArgs(argv);
  const secret = parsed.positionals[0];
  const description = getStringFlag(parsed, "description");
  const unset = getBoolFlag(parsed, "unset");
  if (!secret) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "usage: sm set-description <secret> --description \"...\"  (or --unset)",
    };
  }
  if (description !== undefined && unset) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "cannot specify both --description and --unset",
    };
  }
  if (description === undefined && !unset) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "usage: sm set-description <secret> --description \"...\"  (or --unset)",
    };
  }
  const args: Record<string, unknown> = { secret };
  if (unset) {
    args.description = "";
  } else {
    if (description!.length > 500) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: "`description` must be 500 characters or fewer",
      };
    }
    args.description = description;
  }
  return sendCommand({ cmd: "set-description", args });
});
