import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getRepeatedFlag, getStringFlag, parseArgs } from "../argv";

register("scope", async (argv) => {
  const parsed = parseArgs(argv);
  const secret = parsed.positionals[0];
  const repo = getStringFlag(parsed, "repo");
  const envs = getRepeatedFlag(parsed, "env");
  if (!secret || !repo || envs.length === 0) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "usage: sm scope <secret> --repo REPO --env ENV [--env ENV ...]",
    };
  }
  // Backward-compat: single --env still sends `env: string`.
  // Multiple --env flags send `envs: string[]` (mirrors MCP scope_secret).
  if (envs.length === 1) {
    return sendCommand({ cmd: "scope", args: { secret, repo, env: envs[0] } });
  }
  return sendCommand({ cmd: "scope", args: { secret, repo, envs } });
});
