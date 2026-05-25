import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { parseArgs } from "../argv";

register("remove-secret", async (argv) => {
  const { positionals } = parseArgs(argv);
  const target = positionals[0];
  if (!target) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "usage: sm remove-secret <id|key>",
    };
  }
  return sendCommand({ cmd: "remove-secret", args: { target } });
});
