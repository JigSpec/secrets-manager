import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getRepeatedFlag, parseArgs } from "../argv";

register("set-repo-envs", async (argv) => {
  const parsed = parseArgs(argv);
  const target = parsed.positionals[0];
  const environments = getRepeatedFlag(parsed, "env");
  if (!target || environments.length === 0) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "usage: sm set-repo-envs <id|name> --env ENV [--env ENV ...]",
    };
  }
  return sendCommand({
    cmd: "set-repo-envs",
    args: { target, environments },
  });
});
