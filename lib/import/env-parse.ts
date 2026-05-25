import { promises as fs } from "node:fs";
import path from "node:path";

export type EnvEntry = {
  key: string;
  value: string;
  comment?: string;
  raw: string;
};

/**
 * Parse `.env` file content into an ordered list of `{ key, value, comment?, raw }`.
 * Handles:
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY='single quoted'
 *   KEY=value # trailing comment
 *   (blank lines, full-line `# comment` ignored — but preserved in `raw`)
 *   double-quoted strings interpret \n, \r, \t, \\, \"
 *
 * Lines that don't match `KEY=...` are skipped (they only live in `raw` of
 * the previous entry's adjacent block, so we don't carry them out).
 */
export function parseEnvFile(content: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  const lines = content.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;
    if (line.startsWith("#")) continue;
    if (line.startsWith("export ")) {
      const rest = line.slice("export ".length);
      const parsed = parseAssignment(rest, raw);
      if (parsed) out.push(parsed);
      continue;
    }
    const parsed = parseAssignment(line, raw);
    if (parsed) out.push(parsed);
  }
  return out;
}

function parseAssignment(line: string, raw: string): EnvEntry | null {
  const eq = line.indexOf("=");
  if (eq <= 0) return null;
  const key = line.slice(0, eq).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  let rest = line.slice(eq + 1);
  let value: string;
  let comment: string | undefined;

  if (rest.startsWith('"')) {
    const { body, tail } = sliceQuoted(rest, '"');
    value = unescapeDoubleQuoted(body);
    rest = tail;
  } else if (rest.startsWith("'")) {
    const { body, tail } = sliceQuoted(rest, "'");
    value = body; // single-quoted: no escapes
    rest = tail;
  } else {
    // Unquoted value: up to first unescaped `#` or end of line.
    const hash = rest.indexOf("#");
    if (hash === -1) {
      value = rest.trim();
      rest = "";
    } else {
      value = rest.slice(0, hash).trim();
      rest = rest.slice(hash);
    }
  }

  const trail = rest.trim();
  if (trail.startsWith("#")) {
    comment = trail.slice(1).trim();
  }
  return { key, value, comment, raw };
}

function sliceQuoted(s: string, quote: '"' | "'"): { body: string; tail: string } {
  // s starts with `quote`; find the matching closing quote, honoring
  // backslash-escaped quotes inside double-quoted strings.
  let i = 1;
  let body = "";
  while (i < s.length) {
    const ch = s[i];
    if (ch === "\\" && quote === '"' && i + 1 < s.length) {
      body += s[i] + s[i + 1];
      i += 2;
      continue;
    }
    if (ch === quote) {
      return { body, tail: s.slice(i + 1) };
    }
    body += ch;
    i += 1;
  }
  // Unterminated quote — return what we have.
  return { body, tail: "" };
}

function unescapeDoubleQuoted(body: string): string {
  return body.replace(/\\([nrt"\\])/g, (_m, ch) => {
    switch (ch) {
      case "n":
        return "\n";
      case "r":
        return "\r";
      case "t":
        return "\t";
      case '"':
        return '"';
      case "\\":
        return "\\";
      default:
        return ch;
    }
  });
}

/**
 * Read `.env.<env>` from `repoPath` if `env` is given, else `.env`. Returns
 * the parsed entry list. Missing file → empty list (treated as "nothing
 * to import").
 */
export async function readEnvFile(
  repoPath: string,
  env?: string,
): Promise<EnvEntry[]> {
  const file = path.join(
    repoPath,
    env ? `.env.${env.toLowerCase()}` : ".env",
  );
  let content: string;
  try {
    content = await fs.readFile(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return parseEnvFile(content);
}
