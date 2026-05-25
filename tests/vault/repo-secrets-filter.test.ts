import { describe, expect, it } from "vitest";

import { groupSecretsByEnv, secretsForRepo } from "@/lib/vault/repo-secrets";
import type { Repo, Secret } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const repoA: Repo = {
  id: "repo-a",
  name: "Alpha",
  path: "/repos/alpha",
  environments: ["development", "staging", "production"],
};

const repoB: Repo = {
  id: "repo-b",
  name: "Beta",
  path: "/repos/beta",
  environments: ["development"],
};

const secretOnlyA: Secret = {
  id: "s1",
  key: "DATABASE_URL",
  value: "postgres://localhost",
  scopes: [{ repoId: "repo-a", env: "development" }],
};

const secretOnlyB: Secret = {
  id: "s2",
  key: "API_KEY",
  value: "key-b",
  scopes: [{ repoId: "repo-b", env: "development" }],
};

const secretBothRepos: Secret = {
  id: "s3",
  key: "SHARED_TOKEN",
  value: "shared",
  scopes: [
    { repoId: "repo-a", env: "staging" },
    { repoId: "repo-b", env: "development" },
  ],
};

const secretAProduction: Secret = {
  id: "s4",
  key: "PROD_SECRET",
  value: "prod-value",
  scopes: [{ repoId: "repo-a", env: "production" }],
};

const namespacedSecret: Secret = {
  id: "s5",
  key: "OAUTH_TOKEN",
  value: "oauth-value",
  namespace: "github",
  scopes: [{ repoId: "repo-a", env: "staging" }],
};

const multiEnvSecret: Secret = {
  id: "s6",
  key: "MULTI_ENV_KEY",
  value: "multi-value",
  scopes: [
    { repoId: "repo-a", env: "development" },
    { repoId: "repo-a", env: "production" },
  ],
};

// ---------------------------------------------------------------------------
// secretsForRepo
// ---------------------------------------------------------------------------

describe("secretsForRepo", () => {
  it("returns empty array when no secrets have a scope for the repo", () => {
    const result = secretsForRepo([secretOnlyB], "repo-a");
    expect(result).toEqual([]);
  });

  it("returns only secrets scoped to the target repo (not other repos)", () => {
    const result = secretsForRepo([secretOnlyA, secretOnlyB], "repo-a");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s1");
  });

  it("returns empty array when given an empty secrets input", () => {
    const result = secretsForRepo([], "repo-a");
    expect(result).toEqual([]);
  });

  it("returns a secret scoped to same repo with multiple environments exactly once", () => {
    const result = secretsForRepo([multiEnvSecret], "repo-a");
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("s6");
  });

  it("returns a secret scoped to multiple repos (appears once)", () => {
    const result = secretsForRepo(
      [secretOnlyA, secretOnlyB, secretBothRepos],
      "repo-a",
    );
    const ids = result.map((s) => s.id);
    // secretBothRepos is scoped to both repos — it should appear exactly once
    expect(ids.filter((id) => id === "s3")).toHaveLength(1);
    // secretOnlyB should not appear
    expect(ids).not.toContain("s2");
  });
});

// ---------------------------------------------------------------------------
// groupSecretsByEnv
// ---------------------------------------------------------------------------

describe("groupSecretsByEnv", () => {
  it("returns a Map with one key per repo.environments entry", () => {
    const map = groupSecretsByEnv([], repoA);
    expect(map.size).toBe(repoA.environments.length);
    for (const env of repoA.environments) {
      expect(map.has(env)).toBe(true);
    }
  });

  it("places secrets into the correct env bucket", () => {
    const map = groupSecretsByEnv(
      [secretOnlyA, secretAProduction],
      repoA,
    );
    expect(map.get("development")).toContainEqual(secretOnlyA);
    expect(map.get("production")).toContainEqual(secretAProduction);
    expect(map.get("staging")).toEqual([]);
  });

  it("returns an empty array for an env with no assigned secrets", () => {
    const map = groupSecretsByEnv([secretOnlyA], repoA);
    expect(map.get("staging")).toEqual([]);
    expect(map.get("production")).toEqual([]);
  });

  it("handles a repo with no environments (returns empty Map)", () => {
    const emptyRepo: Repo = {
      id: "repo-empty",
      name: "Empty",
      path: "/repos/empty",
      environments: [],
    };
    const map = groupSecretsByEnv([secretOnlyA], emptyRepo);
    expect(map.size).toBe(0);
  });

  it("does not include a secret in wrong env bucket (scoped to same repo but different env)", () => {
    const map = groupSecretsByEnv([secretOnlyA, secretAProduction], repoA);
    // secretOnlyA is development only — should NOT appear in production
    expect(map.get("production")).not.toContainEqual(secretOnlyA);
    // secretAProduction is production only — should NOT appear in development
    expect(map.get("development")).not.toContainEqual(secretAProduction);
  });

  it("a namespaced secret appears in the correct env bucket", () => {
    const map = groupSecretsByEnv([namespacedSecret], repoA);
    // namespacedSecret is scoped to repo-a / staging
    expect(map.get("staging")).toContainEqual(namespacedSecret);
    expect(map.get("development")).not.toContainEqual(namespacedSecret);
    expect(map.get("production")).not.toContainEqual(namespacedSecret);
  });

  it("a secret scoped to multiple repo+env combinations only appears in the correct bucket", () => {
    // multiEnvSecret is scoped to repo-a/development AND repo-a/production
    const map = groupSecretsByEnv([multiEnvSecret], repoA);
    expect(map.get("development")).toContainEqual(multiEnvSecret);
    expect(map.get("production")).toContainEqual(multiEnvSecret);
    // It should NOT appear in staging
    expect(map.get("staging")).not.toContainEqual(multiEnvSecret);
  });
});
