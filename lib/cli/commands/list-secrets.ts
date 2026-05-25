import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getStringFlag, parseArgs } from "../argv";

register("list-secrets", async (argv) => {
  const parsed = parseArgs(argv);
  const namespace = getStringFlag(parsed, "namespace");
  const args: Record<string, unknown> = {};
  if (namespace !== undefined) args.namespace = namespace;
  return sendCommand({ cmd: "list-secrets", args });
});
