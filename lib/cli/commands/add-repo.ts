import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getRepeatedFlag, getStringFlag, parseArgs } from "../argv";

register("add-repo", async (argv) => {
  const parsed = parseArgs(argv);
  const name = getStringFlag(parsed, "name");
  const path = getStringFlag(parsed, "path");
  const environments = getRepeatedFlag(parsed, "env");
  if (!name || !path || environments.length === 0) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "usage: sm add-repo --name NAME --path PATH --env ENV [--env ENV ...]",
    };
  }
  return sendCommand({
    cmd: "add-repo",
    args: { name, path, environments },
  });
});
