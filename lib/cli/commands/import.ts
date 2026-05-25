import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getBoolFlag, getStringFlag, parseArgs } from "../argv";

register("import", async (argv) => {
  const parsed = parseArgs(argv);
  const repo = getStringFlag(parsed, "repo");
  const env = getStringFlag(parsed, "env");
  const dryRun = getBoolFlag(parsed, "dry-run");
  const defaultNamespace = getStringFlag(parsed, "default-namespace");
  const defaultVariant = getStringFlag(parsed, "default-variant");
  const onConflict = getStringFlag(parsed, "on-conflict");
  if (!repo) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "usage: sm import --repo REPO [--env ENV] [--dry-run] [--default-namespace NS] [--default-variant V] [--on-conflict skip|overwrite|fail]",
    };
  }
  if (
    onConflict !== undefined &&
    onConflict !== "skip" &&
    onConflict !== "overwrite" &&
    onConflict !== "fail"
  ) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message: "--on-conflict must be skip, overwrite, or fail",
    };
  }
  const args: Record<string, unknown> = { repo, dryRun };
  if (env !== undefined) args.env = env;
  if (defaultNamespace !== undefined) args.defaultNamespace = defaultNamespace;
  if (defaultVariant !== undefined) args.defaultVariant = defaultVariant;
  if (onConflict !== undefined) args.onConflict = onConflict;
  return sendCommand({ cmd: "import", args });
});
