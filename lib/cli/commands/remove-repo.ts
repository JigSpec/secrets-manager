import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { parseArgs } from "../argv";

register("remove-repo", async (argv) => {
  const { positionals } = parseArgs(argv);
  const target = positionals[0];
  if (!target) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "usage: sm remove-repo <id|name>",
    };
  }
  return sendCommand({ cmd: "remove-repo", args: { target } });
});
