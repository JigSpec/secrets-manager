import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getBoolFlag, getStringFlag, parseArgs } from "../argv";

register("set-variant", async (argv) => {
  const parsed = parseArgs(argv);
  const secret = parsed.positionals[0];
  const variant = getStringFlag(parsed, "variant");
  const unset = getBoolFlag(parsed, "unset");
  if (!secret || (!variant && !unset)) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "usage: sm set-variant <secret> --variant V  (or --unset)",
    };
  }
  if (variant && unset) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "cannot specify both --variant and --unset",
    };
  }
  const args: Record<string, unknown> = { secret };
  if (unset) args.unset = true;
  else args.variant = variant;
  return sendCommand({ cmd: "set-variant", args });
});
