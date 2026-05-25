import { describe, expect, it } from "vitest";

import { migrateFromV1 } from "@/lib/vault/migrate";
import { VaultDataSchema } from "@/lib/vault/schema";
import { VaultError } from "@/lib/vault/errors";

describe("migrateFromV1", () => {
  it("wraps an unversioned (v0.1) blob into v2 and leaves namespace absent", () => {
    const v1 = {
      repos: [
        {
          id: "r1",
          name: "alpha",
          path: "/tmp/alpha",
          environments: ["development"],
        },
      ],
      secrets: [
        {
          id: "s1",
          key: "DATABASE_URL",
          value: "postgres://localhost",
          scopes: [{ repoId: "r1", env: "development" }],
        },
      ],
    };
    const out = migrateFromV1(v1) as Record<string, unknown>;
    expect(out.version).toBe(2);
    expect(out.repos).toEqual(v1.repos);
    expect(out.secrets).toEqual(v1.secrets);
    const parsed = VaultDataSchema.parse(out);
    expect(parsed.secrets[0].namespace).toBeUndefined();
  });

  it("passes through a v2 blob unchanged", () => {
    const v2 = {
      version: 2,
      repos: [],
      secrets: [
        {
          id: "s1",
          key: "API_KEY",
          value: "x",
          namespace: "gmail",
          scopes: [],
        },
      ],
    };
    const out = migrateFromV1(v2);
    expect(out).toBe(v2);
    const parsed = VaultDataSchema.parse(out);
    expect(parsed.secrets[0].namespace).toBe("gmail");
  });

  it("rejects a future version with INCOMPATIBLE_VAULT_VERSION", () => {
    expect(() => migrateFromV1({ version: 99, repos: [], secrets: [] })).toThrow(
      VaultError,
    );
    try {
      migrateFromV1({ version: 7, repos: [], secrets: [] });
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).code).toBe("INCOMPATIBLE_VAULT_VERSION");
    }
  });

  it("survives an explicitly-versioned v1 (e.g. someone hand-typed it)", () => {
    const v1 = {
      version: 1,
      repos: [],
      secrets: [
        {
          id: "s1",
          key: "TOKEN",
          value: "abc",
          scopes: [],
        },
      ],
    };
    const out = migrateFromV1(v1) as Record<string, unknown>;
    expect(out.version).toBe(2);
    expect(VaultDataSchema.parse(out).secrets[0].namespace).toBeUndefined();
  });

  it("returns non-objects untouched (zod handles rejection)", () => {
    expect(migrateFromV1(null)).toBeNull();
    expect(migrateFromV1(42)).toBe(42);
    expect(migrateFromV1([])).toEqual([]);
  });
});

describe("VaultDataSchema (v2)", () => {
  it("accepts secrets with valid lowercase namespace", () => {
    const ok = VaultDataSchema.parse({
      version: 2,
      repos: [],
      secrets: [
        {
          id: "s",
          key: "K",
          value: "v",
          namespace: "gmail",
          scopes: [],
        },
      ],
    });
    expect(ok.secrets[0].namespace).toBe("gmail");
  });

  it("rejects uppercase namespace", () => {
    expect(() =>
      VaultDataSchema.parse({
        version: 2,
        repos: [],
        secrets: [
          {
            id: "s",
            key: "K",
            value: "v",
            namespace: "GMAIL",
            scopes: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects namespace with hyphen", () => {
    expect(() =>
      VaultDataSchema.parse({
        version: 2,
        repos: [],
        secrets: [
          {
            id: "s",
            key: "K",
            value: "v",
            namespace: "my-app",
            scopes: [],
          },
        ],
      }),
    ).toThrow();
  });

  it("rejects keys with lowercase letters", () => {
    expect(() =>
      VaultDataSchema.parse({
        version: 2,
        repos: [],
        secrets: [
          {
            id: "s",
            key: "Db_Url",
            value: "v",
            scopes: [],
          },
        ],
      }),
    ).toThrow();
  });
});
