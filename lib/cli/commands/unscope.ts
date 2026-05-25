import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getStringFlag, parseArgs } from "../argv";

register("unscope", async (argv) => {
  const parsed = parseArgs(argv);
  const secret = parsed.positionals[0];
  const repo = getStringFlag(parsed, "repo");
  const env = getStringFlag(parsed, "env");
  if (!secret || !repo || !env) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "usage: sm unscope <secret> --repo REPO --env ENV",
    };
  }
  return sendCommand({ cmd: "unscope", args: { secret, repo, env } });
});
