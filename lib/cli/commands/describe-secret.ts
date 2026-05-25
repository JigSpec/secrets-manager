import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { parseArgs } from "../argv";

register("describe-secret", async (argv) => {
  const { positionals } = parseArgs(argv);
  const target = positionals[0];
  if (!target) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "usage: sm describe-secret <id|key>",
    };
  }
  return sendCommand({ cmd: "describe-secret", args: { id: target } });
});
