import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getStringFlag, parseArgs } from "../argv";

register("update-repo-path", async (argv) => {
  const parsed = parseArgs(argv);
  const repo = getStringFlag(parsed, "repo") ?? parsed.positionals[0];
  const path = getStringFlag(parsed, "path") ?? parsed.positionals[1];
  if (!repo || !path) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "usage: sm update-repo-path <repo> <path>",
    };
  }
  return sendCommand({
    cmd: "update-repo-path",
    args: { repo, path },
  });
});
