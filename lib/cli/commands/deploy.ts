import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getBoolFlag, getStringFlag, parseArgs } from "../argv";

register("deploy", async (argv) => {
  const parsed = parseArgs(argv);
  const repo = getStringFlag(parsed, "repo");
  const env = getStringFlag(parsed, "env");
  const dryRun = getBoolFlag(parsed, "dry-run");
  const localOnly = getBoolFlag(parsed, "local-only");
  const args: Record<string, unknown> = { dryRun, localOnly };
  if (repo !== undefined) args.repo = repo;
  if (env !== undefined) args.env = env;
  return sendCommand({ cmd: "deploy", args });
});
