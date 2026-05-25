/**
 * Minimal `--flag value` / `--flag=value` / `--flag` argv parser tailored
 * for `sm` subcommand flags. Repeated flags accumulate into an array.
 *
 * Positional arguments are anything not prefixed with `--`. `--` ends
 * flag parsing.
 */
export type ParsedArgs = {
  positionals: string[];
  flags: Record<string, string | string[] | boolean>;
};

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | string[] | boolean> = {};
  let i = 0;
  let endOfFlags = false;
  while (i < argv.length) {
    const a = argv[i];
    if (endOfFlags) {
      positionals.push(a);
      i += 1;
      continue;
    }
    if (a === "--") {
      endOfFlags = true;
      i += 1;
      continue;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a.slice(2) : a.slice(2, eq);
      let value: string | true;
      if (eq !== -1) {
        value = a.slice(eq + 1);
        i += 1;
      } else {
        const peek = argv[i + 1];
        if (peek === undefined || peek.startsWith("--")) {
          value = true;
          i += 1;
        } else {
          value = peek;
          i += 2;
        }
      }
      const prev = flags[name];
      if (prev === undefined) {
        flags[name] = value === true ? true : value;
      } else if (value === true) {
        flags[name] = true;
      } else if (Array.isArray(prev)) {
        prev.push(value);
      } else if (typeof prev === "string") {
        flags[name] = [prev, value];
      } else {
        flags[name] = value;
      }
      continue;
    }
    positionals.push(a);
    i += 1;
  }
  return { positionals, flags };
}

export function getStringFlag(
  parsed: ParsedArgs,
  name: string,
): string | undefined {
  const v = parsed.flags[name];
  if (typeof v === "string") return v;
  if (Array.isArray(v)) return v[v.length - 1];
  return undefined;
}

export function getRepeatedFlag(
  parsed: ParsedArgs,
  name: string,
): string[] {
  const v = parsed.flags[name];
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

export function getBoolFlag(parsed: ParsedArgs, name: string): boolean {
  const v = parsed.flags[name];
  if (v === true) return true;
  if (v === "true") return true;
  return false;
}
