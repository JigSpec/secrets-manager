import { describe, expect, it } from "vitest";

import {
  detectCollisions,
  secretsForCell,
  writtenKeyFor,
} from "@/lib/vault/deploy/write-key";
import type { Secret } from "@/lib/vault/schema";

function s(over: Partial<Secret> & { id: string; key: string }): Secret {
  return {
    value: "v",
    scopes: [],
    ...over,
  } as Secret;
}

describe("writtenKeyFor", () => {
  // issue #78 — namespace is a vault-internal disambiguator only; the env-var
  // name written to .env.<env> is always the bare key, regardless of namespace.
  it("is identity when namespace is undefined", () => {
    // issue #78
    expect(writtenKeyFor({ key: "DATABASE_URL", namespace: undefined })).toBe(
      "DATABASE_URL",
    );
  });

  it("ignores namespace entirely (no NS_ prefix)", () => {
    // issue #78 — replaces the pre-#78 "uppercases the namespace and joins
    // with _" behaviour. namespace=gmail must NOT yield GMAIL_DATABASE_URL.
    expect(writtenKeyFor({ key: "DATABASE_URL", namespace: "gmail" })).toBe(
      "DATABASE_URL",
    );
  });

  it("ignores namespace=stripe (returns bare API_KEY)", () => {
    // issue #78
    expect(writtenKeyFor({ key: "API_KEY", namespace: "stripe" })).toBe(
      "API_KEY",
    );
  });

  it("ignores empty-string namespace defensively", () => {
    // issue #78 — same identity-on-key behaviour, just covers the
    // defense-in-depth path where a hand-built secret slips through schema.
    expect(writtenKeyFor({ key: "X", namespace: "" })).toBe("X");
  });
});

describe("detectCollisions", () => {
  it("returns no collisions when keys are unique", () => {
    const out = detectCollisions([
      s({ id: "a", key: "A" }),
      s({ id: "b", key: "B" }),
    ]);
    expect(out).toEqual([]);
  });

  it("does NOT flag ns-less GMAIL_X vs ns=gmail key=X (now distinct keys)", () => {
    // issue #78 — under the post-#78 contract these two secrets write as
    // GMAIL_DATABASE_URL and DATABASE_URL respectively (the namespace no
    // longer participates in the written key), so they no longer collide.
    const out = detectCollisions([
      s({ id: "a", key: "GMAIL_DATABASE_URL" }),
      s({ id: "b", key: "DATABASE_URL", namespace: "gmail" }),
    ]);
    expect(out).toEqual([]);
  });

  it("flags three-way collision on bare key API_KEY", () => {
    // issue #78 — all three secrets now write as API_KEY (namespace ignored),
    // so they collide on a single written key.
    const out = detectCollisions([
      s({ id: "a", key: "API_KEY" }),
      s({ id: "b", key: "API_KEY", namespace: "gmail" }),
      s({ id: "c", key: "API_KEY", namespace: "stripe" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].writtenKey).toBe("API_KEY");
    expect(out[0].members).toHaveLength(3);
    expect(out[0].members.map((m) => m.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("flags distinct namespaces with the same key as a collision", () => {
    // issue #78 — pre-#78 these two were considered distinct (DATABASE_URL
    // would land as GMAIL_DATABASE_URL vs PIZZERIA_DATABASE_URL). Post-#78
    // both write as DATABASE_URL → they collide.
    const out = detectCollisions([
      s({ id: "a", key: "DATABASE_URL", namespace: "gmail" }),
      s({ id: "b", key: "DATABASE_URL", namespace: "pizzeria" }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].writtenKey).toBe("DATABASE_URL");
    expect(out[0].members.map((m) => m.id).sort()).toEqual(["a", "b"]);
  });
});

describe("secretsForCell", () => {
  it("returns only secrets scoped to the cell", () => {
    const all = [
      s({
        id: "a",
        key: "A",
        scopes: [{ repoId: "r1", env: "prod" }],
      }),
      s({
        id: "b",
        key: "B",
        scopes: [
          { repoId: "r1", env: "prod" },
          { repoId: "r2", env: "dev" },
        ],
      }),
      s({
        id: "c",
        key: "C",
        scopes: [{ repoId: "r2", env: "dev" }],
      }),
    ];
    const out = secretsForCell(all, { repoId: "r1", env: "prod" });
    expect(out.map((x) => x.id).sort()).toEqual(["a", "b"]);
  });
});
