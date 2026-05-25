import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getBoolFlag, getStringFlag, parseArgs } from "../argv";

register("set-namespace", async (argv) => {
  const parsed = parseArgs(argv);
  const secret = parsed.positionals[0];
  const namespace = getStringFlag(parsed, "namespace");
  const unset = getBoolFlag(parsed, "unset");
  if (!secret || (!namespace && !unset)) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "usage: sm set-namespace <secret> --namespace NS  (or --unset)",
    };
  }
  if (namespace && unset) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "cannot specify both --namespace and --unset",
    };
  }
  const args: Record<string, unknown> = { secret };
  if (unset) args.unset = true;
  else args.namespace = namespace;
  return sendCommand({ cmd: "set-namespace", args });
});
