/**
 * Unit tests for the Phase 4 variant-aware resolver helpers in
 * `lib/daemon/handlers/_resolve.ts`:
 *
 *   - `findSecretByKeyAndVariant` — id-first, then (key, variant) match
 *   - `findSecretOrAmbiguous` — extended with an optional `variant` arg that
 *     disambiguates the previously-AMBIGUOUS case when exactly one by-key
 *     candidate matches the variant
 *
 * These are pure function tests — no daemon harness, no IPC.
 */

import { describe, expect, it } from "vitest";

import {
  findSecretByKeyAndVariant,
  findSecretOrAmbiguous,
} from "@/lib/daemon/handlers/_resolve";
import type { Secret, VaultData } from "@/lib/vault/schema";

function mkSecret(partial: Partial<Secret> & { id: string; key: string }): Secret {
  return {
    flavor: "value-from-file",
    scopes: [],
    ...partial,
  } as Secret;
}

function mkData(secrets: Secret[]): VaultData {
  return {
    version: 4,
    repos: [],
    secrets,
    envVariantMap: { global: {}, repos: {} },
  } as VaultData;
}

describe("findSecretByKeyAndVariant", () => {
  // (a) ID match wins — variant arg is irrelevant when needle is an id.
  it("matches by id first, ignoring variant", async () => {
    const s1 = mkSecret({ id: "id-1", key: "API_KEY", variant: "live" });
    const s2 = mkSecret({ id: "id-2", key: "API_KEY", variant: "test" });
    const data = mkData([s1, s2]);
    const match = findSecretByKeyAndVariant(data, "id-1", "test");
    expect(match?.id).toBe("id-1");
  });

  // (b) (key, variant) tuple uniquely identifies the secret.
  it("matches by (key, variant) when there are siblings", async () => {
    const s1 = mkSecret({ id: "id-1", key: "API_KEY", variant: "live" });
    const s2 = mkSecret({ id: "id-2", key: "API_KEY", variant: "test" });
    const data = mkData([s1, s2]);
    const match = findSecretByKeyAndVariant(data, "API_KEY", "test");
    expect(match?.id).toBe("id-2");
  });

  // (c) No matching (key, variant) pair → undefined.
  it("returns undefined when no (key, variant) pair matches", async () => {
    const s1 = mkSecret({ id: "id-1", key: "API_KEY", variant: "live" });
    const data = mkData([s1]);
    const match = findSecretByKeyAndVariant(data, "API_KEY", "staging");
    expect(match).toBeUndefined();
  });
});

describe("findSecretOrAmbiguous", () => {
  // (d) The variant arg disambiguates an otherwise-AMBIGUOUS bare-key lookup.
  it("with variant arg, disambiguates the AMBIGUOUS case", async () => {
    const s1 = mkSecret({ id: "id-1", key: "API_KEY", variant: "live" });
    const s2 = mkSecret({ id: "id-2", key: "API_KEY", variant: "test" });
    const data = mkData([s1, s2]);
    const match = findSecretOrAmbiguous(data, "API_KEY", "live");
    expect(match).not.toBe("AMBIGUOUS");
    expect(match).toBeDefined();
    if (match === undefined || match === "AMBIGUOUS") return;
    expect(match.id).toBe("id-1");
  });

  // (e) Without the variant arg, the old behaviour is preserved (AMBIGUOUS).
  it("without variant arg, preserves old behaviour (AMBIGUOUS on 2+ same-key matches)", async () => {
    const s1 = mkSecret({ id: "id-1", key: "API_KEY", variant: "live" });
    const s2 = mkSecret({ id: "id-2", key: "API_KEY", variant: "test" });
    const data = mkData([s1, s2]);
    const match = findSecretOrAmbiguous(data, "API_KEY");
    expect(match).toBe("AMBIGUOUS");
  });

  // Sanity: passing a variant arg that matches NEITHER candidate also
  // returns AMBIGUOUS (filtering reduces to zero, not one).
  it("returns AMBIGUOUS when the variant arg matches zero candidates", async () => {
    const s1 = mkSecret({ id: "id-1", key: "API_KEY", variant: "live" });
    const s2 = mkSecret({ id: "id-2", key: "API_KEY", variant: "test" });
    const data = mkData([s1, s2]);
    const match = findSecretOrAmbiguous(data, "API_KEY", "staging");
    expect(match).toBe("AMBIGUOUS");
  });
});
