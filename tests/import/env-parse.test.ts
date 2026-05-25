import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { parseEnvFile, readEnvFile } from "@/lib/import/env-parse";

describe("parseEnvFile", () => {
  it("parses simple unquoted assignments", () => {
    const out = parseEnvFile("FOO=bar\nBAZ=qux\n");
    expect(out.map((e) => [e.key, e.value])).toEqual([
      ["FOO", "bar"],
      ["BAZ", "qux"],
    ]);
  });

  it("trims unquoted values", () => {
    const out = parseEnvFile("FOO=   bar baz   \n");
    expect(out[0].value).toBe("bar baz");
  });

  it("preserves double-quoted contents and unescapes \\n", () => {
    const out = parseEnvFile(`KEY="line one\\nline two"\n`);
    expect(out[0].value).toBe("line one\nline two");
  });

  it("does not unescape inside single quotes", () => {
    const out = parseEnvFile(`KEY='no \\n escape'\n`);
    expect(out[0].value).toBe("no \\n escape");
  });

  it("captures trailing comments on unquoted lines", () => {
    const out = parseEnvFile("FOO=bar # a comment\n");
    expect(out[0].value).toBe("bar");
    expect(out[0].comment).toBe("a comment");
  });

  it("does not split # inside quotes", () => {
    const out = parseEnvFile(`KEY="value # not a comment"\n`);
    expect(out[0].value).toBe("value # not a comment");
    expect(out[0].comment).toBeUndefined();
  });

  it("ignores blank lines and full-line comments", () => {
    const out = parseEnvFile(`\n# leading\nFOO=bar\n\n# trailing\n`);
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("FOO");
  });

  it("accepts `export KEY=value`", () => {
    const out = parseEnvFile(`export FOO=bar\n`);
    expect(out[0].key).toBe("FOO");
    expect(out[0].value).toBe("bar");
  });

  it("skips lines that don't look like KEY=...", () => {
    const out = parseEnvFile("not a real line\nFOO=bar\n");
    expect(out).toHaveLength(1);
    expect(out[0].key).toBe("FOO");
  });

  it("preserves source order", () => {
    const out = parseEnvFile("Z=1\nA=2\nM=3\n");
    expect(out.map((e) => e.key)).toEqual(["Z", "A", "M"]);
  });

  it("preserves the raw input line", () => {
    const out = parseEnvFile(`FOO="hi"\nBAR=2\n`);
    expect(out[0].raw).toBe('FOO="hi"');
  });
});

describe("readEnvFile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "envparse-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads .env when no env specified", async () => {
    await writeFile(path.join(dir, ".env"), "FOO=bar\n", "utf8");
    const out = await readEnvFile(dir);
    expect(out.map((e) => e.key)).toEqual(["FOO"]);
  });

  it("reads .env.<env> when specified, lowercases env name", async () => {
    await writeFile(path.join(dir, ".env.development"), "DEV=1\n", "utf8");
    const out = await readEnvFile(dir, "Development");
    expect(out.map((e) => e.key)).toEqual(["DEV"]);
  });

  it("returns empty list when file missing", async () => {
    const out = await readEnvFile(dir, "ghost");
    expect(out).toEqual([]);
  });
});
