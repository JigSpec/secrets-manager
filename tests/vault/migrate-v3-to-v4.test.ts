// Vault migration tests: v3 → v4 (issue #41).

import { describe, expect, it } from "vitest";

import { VaultDataV4Schema, TutorialSchema } from "@/lib/vault/schema";
import { migrateV3toV4 } from "@/lib/vault/migrate/v3-to-v4";

/** A minimal valid v3 vault object. */
function baseV3() {
  return {
    version: 3 as const,
    repos: [] as unknown[],
    secrets: [] as unknown[],
    envVariantMap: { global: {}, repos: {} },
  };
}

/** A minimal valid tutorial object. */
function validTutorial() {
  return {
    steps: [
      {
        order: 1,
        title: "Obtain your API key",
        body: "Log in to the provider dashboard and navigate to API Keys.",
      },
    ],
    createdAt: new Date().toISOString(),
  };
}

describe("migrateV3toV4", () => {
  it("migrates a vault object with version: 3 to version: 4", () => {
    const v3 = baseV3();
    const out = migrateV3toV4(v3) as Record<string, unknown>;
    expect(out.version).toBe(4);
  });

  it("preserves repos, secrets and envVariantMap on migration", () => {
    const v3 = {
      ...baseV3(),
      repos: [
        {
          id: "r1",
          name: "alpha",
          path: "/repos/alpha",
          environments: ["development"],
        },
      ],
      secrets: [
        {
          id: "s1",
          key: "DATABASE_URL",
          value: "postgres://localhost",
          scopes: [],
        },
      ],
      envVariantMap: { global: { development: "test" }, repos: {} },
    };

    const out = migrateV3toV4(v3) as Record<string, unknown>;
    expect(out.version).toBe(4);
    expect(out.repos).toEqual(v3.repos);
    expect(out.secrets).toEqual(v3.secrets);
    expect(out.envVariantMap).toEqual(v3.envVariantMap);
  });

  it("passes through a vault that is already v4 unchanged", () => {
    const v4 = {
      version: 4,
      repos: [],
      secrets: [],
      envVariantMap: { global: {}, repos: {} },
    };
    const out = migrateV3toV4(v4) as Record<string, unknown>;
    expect(out.version).toBe(4);
  });
});

describe("VaultDataV4Schema", () => {
  function baseV4() {
    return {
      version: 4 as const,
      repos: [] as unknown[],
      secrets: [] as unknown[],
      envVariantMap: { global: {}, repos: {} },
    };
  }

  it("accepts a minimal v4 vault with no secrets", () => {
    const result = VaultDataV4Schema.safeParse(baseV4());
    expect(result.success).toBe(true);
  });

  it("accepts a v4 vault whose secret has a valid tutorial", () => {
    const data = {
      ...baseV4(),
      secrets: [
        {
          id: "s1",
          key: "API_KEY",
          value: "supersecretvalue",
          scopes: [],
          tutorial: validTutorial(),
        },
      ],
    };
    const result = VaultDataV4Schema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("accepts a v4 vault whose secret has no tutorial (tutorial is optional)", () => {
    const data = {
      ...baseV4(),
      secrets: [
        {
          id: "s1",
          key: "API_KEY",
          value: "supersecretvalue",
          scopes: [],
        },
      ],
    };
    const result = VaultDataV4Schema.safeParse(data);
    expect(result.success).toBe(true);
  });

  it("rejects a v4 vault whose secret has a tutorial with an invalid step shape", () => {
    const badTutorial = {
      steps: [
        {
          // Missing `title` and `body` — invalid step shape.
          order: 1,
        },
      ],
      createdAt: new Date().toISOString(),
    };
    const data = {
      ...baseV4(),
      secrets: [
        {
          id: "s1",
          key: "API_KEY",
          value: "supersecretvalue",
          scopes: [],
          tutorial: badTutorial,
        },
      ],
    };
    const result = VaultDataV4Schema.safeParse(data);
    expect(result.success).toBe(false);
  });

  it("rejects a v4 vault whose secret has a tutorial with an empty steps array", () => {
    const data = {
      ...baseV4(),
      secrets: [
        {
          id: "s1",
          key: "API_KEY",
          value: "supersecretvalue",
          scopes: [],
          tutorial: {
            steps: [],
            createdAt: new Date().toISOString(),
          },
        },
      ],
    };
    const result = VaultDataV4Schema.safeParse(data);
    expect(result.success).toBe(false);
  });
});

describe("TutorialSchema (re-check via vault migration context)", () => {
  it("accepts a full tutorial with mayBeStale and authorAgent", () => {
    const result = TutorialSchema.safeParse({
      ...validTutorial(),
      mayBeStale: true,
      authorAgent: "claude-sonnet-4-5",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a tutorial whose step has a body exceeding 2000 characters", () => {
    const result = TutorialSchema.safeParse({
      steps: [{ order: 1, title: "Step 1", body: "X".repeat(2001) }],
      createdAt: new Date().toISOString(),
    });
    expect(result.success).toBe(false);
  });
});
