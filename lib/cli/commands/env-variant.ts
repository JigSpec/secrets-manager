import { register } from "../router";
import { sendCommand } from "../ipc-client";
import { getStringFlag, parseArgs } from "../argv";

/**
 * sm env-variant <list|set|unset> — manage the vault's envVariantMap.
 *
 * Sub-verbs (positional, required):
 *   list
 *     Args: none.
 *
 *   set --env ENV --variant V [--repo REPO]
 *     Args: env (required), variant (required), repo (optional — without
 *     repo, sets a global override; with repo, sets a per-repo override).
 *
 *   unset --env ENV [--repo REPO]
 *     Args: env (required), repo (optional — without repo, removes a
 *     global override; with repo, removes a per-repo override).
 *
 * Daemon IPC commands (hyphenated) live at lib/daemon/handlers/env-variant.ts.
 */
register("env-variant", async (argv) => {
  const parsed = parseArgs(argv);
  const subverb = parsed.positionals[0];

  if (!subverb) {
    return {
      ok: false,
      code: "INVALID_INPUT",
      message:
        "usage: sm env-variant <list|set|unset> [flags]\n" +
        "  list                                          — show current envVariantMap\n" +
        "  set --env ENV --variant V [--repo REPO]       — add an override\n" +
        "  unset --env ENV [--repo REPO]                 — remove an override",
    };
  }

  if (subverb === "list") {
    return sendCommand({ cmd: "env-variant-list" });
  }

  if (subverb === "set") {
    const env = getStringFlag(parsed, "env");
    const variant = getStringFlag(parsed, "variant");
    const repo = getStringFlag(parsed, "repo");
    if (!env || !variant) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: "usage: sm env-variant set --env ENV --variant V [--repo REPO]",
      };
    }
    const args: Record<string, unknown> = { env, variant };
    if (repo !== undefined) args.repo = repo;
    return sendCommand({ cmd: "env-variant-set", args });
  }

  if (subverb === "unset") {
    const env = getStringFlag(parsed, "env");
    const repo = getStringFlag(parsed, "repo");
    if (!env) {
      return {
        ok: false,
        code: "INVALID_INPUT",
        message: "usage: sm env-variant unset --env ENV [--repo REPO]",
      };
    }
    const args: Record<string, unknown> = { env };
    if (repo !== undefined) args.repo = repo;
    return sendCommand({ cmd: "env-variant-unset", args });
  }

  return {
    ok: false,
    code: "INVALID_INPUT",
    message:
      `unknown sub-verb "${subverb}". usage: sm env-variant <list|set|unset> [flags]`,
  };
});
