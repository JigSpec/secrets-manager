import { describe, expect, it } from "vitest";

import { migrateToLatest } from "@/lib/vault/migrate";
import { VaultDataSchema, EnvVariantMapSchema } from "@/lib/vault/schema";
import { VaultError } from "@/lib/vault/errors";
import { DEFAULT_ENV_VARIANT_MAP } from "@/lib/vault/variant/resolve";

// ---------------------------------------------------------------------------
// migrateToLatest: v2 → v4
// ---------------------------------------------------------------------------
describe("migrateToLatest", () => {
  it("converts a v2 blob → v4, preserving repos/secrets and adding envVariantMap", () => {
    const v2 = {
      version: 2,
      repos: [
        {
          id: "r1",
          name: "alpha",
          path: "/tmp/alpha",
          environments: ["development", "production"],
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

    const out = migrateToLatest(v2) as Record<string, unknown>;

    expect(out.version).toBe(4);
    expect(out.repos).toEqual(v2.repos);
    expect(out.secrets).toEqual(v2.secrets);
    // migrateV2toV3 injects DEFAULT_ENV_VARIANT_MAP into global on migration
    expect(out.envVariantMap).toEqual({ global: DEFAULT_ENV_VARIANT_MAP, repos: {} });
  });

  it("upgrades a v3 blob to v4", () => {
    const v3 = {
      version: 3,
      repos: [],
      secrets: [],
      envVariantMap: {
        global: { development: "test" },
        repos: {},
      },
    };

    const out = migrateToLatest(v3) as Record<string, unknown>;

    expect(out.version).toBe(4);
    expect((out.envVariantMap as Record<string, unknown>)).toEqual({
      global: { development: "test" },
      repos: {},
    });
  });

  it("handles unversioned (v0.1) blob → produces v4", () => {
    const v0 = {
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
          key: "TOKEN",
          value: "abc",
          scopes: [],
        },
      ],
    };

    const out = migrateToLatest(v0) as Record<string, unknown>;

    expect(out.version).toBe(4);
    expect(out.repos).toEqual(v0.repos);
    expect(out.secrets).toEqual(v0.secrets);
    // migrateV2toV3 injects DEFAULT_ENV_VARIANT_MAP into global on migration
    expect(out.envVariantMap).toEqual({ global: DEFAULT_ENV_VARIANT_MAP, repos: {} });
  });

  it("throws INCOMPATIBLE_VAULT_VERSION for version > 4", () => {
    expect(() => migrateToLatest({ version: 5, repos: [], secrets: [] })).toThrow(
      VaultError,
    );
    try {
      migrateToLatest({ version: 99, repos: [], secrets: [] });
      throw new Error("should not reach");
    } catch (err) {
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).code).toBe("INCOMPATIBLE_VAULT_VERSION");
    }
  });
});

// ---------------------------------------------------------------------------
// VaultDataSchema (v3)
// ---------------------------------------------------------------------------
describe("VaultDataSchema (v3)", () => {
  function baseV3() {
    return {
      version: 3 as const,
      repos: [],
      secrets: [] as unknown[],
      envVariantMap: { global: {}, repos: {} },
    };
  }

  it("accepts a secret with a valid variant field", () => {
    const data = {
      ...baseV3(),
      secrets: [
        {
          id: "s1",
          key: "API_KEY",
          value: "x",
          variant: "live",
          scopes: [],
        },
      ],
    };
    const parsed = VaultDataSchema.parse(data);
    expect(parsed.secrets[0].variant).toBe("live");
  });

  it("rejects variant with uppercase characters", () => {
    const data = {
      ...baseV3(),
      secrets: [
        {
          id: "s1",
          key: "API_KEY",
          value: "x",
          variant: "Live",
          scopes: [],
        },
      ],
    };
    expect(() => VaultDataSchema.parse(data)).toThrow();
  });

  it("rejects variant with hyphens", () => {
    const data = {
      ...baseV3(),
      secrets: [
        {
          id: "s1",
          key: "API_KEY",
          value: "x",
          variant: "my-variant",
          scopes: [],
        },
      ],
    };
    expect(() => VaultDataSchema.parse(data)).toThrow();
  });

  it("allows two secrets with same (key, namespace) but different variants", () => {
    const data = {
      ...baseV3(),
      secrets: [
        {
          id: "s1",
          key: "API_KEY",
          value: "x",
          namespace: "stripe",
          variant: "test",
          scopes: [],
        },
        {
          id: "s2",
          key: "API_KEY",
          value: "y",
          namespace: "stripe",
          variant: "live",
          scopes: [],
        },
      ],
    };
    const parsed = VaultDataSchema.parse(data);
    expect(parsed.secrets).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// EnvVariantMapSchema
// ---------------------------------------------------------------------------
describe("EnvVariantMapSchema", () => {
  it("accepts a valid map with global and per-repo overrides", () => {
    const input = {
      global: {
        development: "test",
        staging: "staging",
        production: "live",
      },
      repos: {
        r1: {
          development: "preview",
        },
      },
    };
    const parsed = EnvVariantMapSchema.parse(input);
    expect(parsed.global["development"]).toBe("test");
    expect(parsed.repos["r1"]?.["development"]).toBe("preview");
  });

  it("accepts an empty global and empty repos map", () => {
    const parsed = EnvVariantMapSchema.parse({ global: {}, repos: {} });
    expect(parsed.global).toEqual({});
    expect(parsed.repos).toEqual({});
  });

  it("rejects when global is missing", () => {
    expect(() =>
      EnvVariantMapSchema.parse({ repos: {} }),
    ).toThrow();
  });

  it("rejects when repos is missing", () => {
    expect(() =>
      EnvVariantMapSchema.parse({ global: {} }),
    ).toThrow();
  });
});
