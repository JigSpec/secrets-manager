import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getStringFlag, parseArgs } from "../argv";

register("rename-secret", async (argv) => {
  const parsed = parseArgs(argv);
  const secret = parsed.positionals[0];
  const newKey = getStringFlag(parsed, "new-key");
  if (!secret || !newKey) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "usage: sm rename-secret <secret> --new-key NEW",
    };
  }
  return sendCommand({ cmd: "rename-secret", args: { secret, newKey } });
});
