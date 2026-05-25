import { writeFile, mkdtemp, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { readValueFromFile } from "@/lib/daemon/value-handoff";

let scratch: string;

async function fileExists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  scratch = await mkdtemp(path.join(tmpdir(), "sm-vh-"));
});

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(scratch, { recursive: true, force: true });
});

describe("readValueFromFile", () => {
  it("returns the file's utf-8 contents and an unlinker", async () => {
    const p = path.join(scratch, "v.txt");
    await writeFile(p, "hello world", "utf8");
    const h = await readValueFromFile(p);
    expect(h.value).toBe("hello world");
    expect(typeof h.unlink).toBe("function");
    expect(await fileExists(p)).toBe(true);

    await h.unlink();
    expect(await fileExists(p)).toBe(false);
  });

  it("unlink is idempotent", async () => {
    const p = path.join(scratch, "v.txt");
    await writeFile(p, "x", "utf8");
    const h = await readValueFromFile(p);
    await h.unlink();
    await h.unlink(); // must not throw
    expect(await fileExists(p)).toBe(false);
  });

  it("throws when the file does not exist", async () => {
    await expect(
      readValueFromFile(path.join(scratch, "missing.txt")),
    ).rejects.toBeTruthy();
  });
});
