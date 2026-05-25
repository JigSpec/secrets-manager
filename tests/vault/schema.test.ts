import { describe, expect, it } from "vitest";

import { EnvVariantMapSchema, SecretSchema } from "@/lib/vault/schema";

describe("EnvVariantMapSchema — variant value validation (H1)", () => {
  it("accepts valid variant strings in global map", () => {
    const result = EnvVariantMapSchema.safeParse({
      global: { development: "test", production: "live" },
      repos: {},
    });
    expect(result.success).toBe(true);
  });

  it("accepts valid variant strings in per-repo map", () => {
    const result = EnvVariantMapSchema.safeParse({
      global: {},
      repos: { r1: { development: "preview" } },
    });
    expect(result.success).toBe(true);
  });

  it("rejects invalid variant string in global map (uppercase)", () => {
    const result = EnvVariantMapSchema.safeParse({
      global: { development: "INVALID" },
      repos: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid variant string in global map (hyphen)", () => {
    const result = EnvVariantMapSchema.safeParse({
      global: { development: "my-variant" },
      repos: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid variant string in global map (starts with digit)", () => {
    const result = EnvVariantMapSchema.safeParse({
      global: { development: "1test" },
      repos: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid variant string in global map (empty string)", () => {
    const result = EnvVariantMapSchema.safeParse({
      global: { development: "" },
      repos: {},
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid variant string in per-repo map", () => {
    const result = EnvVariantMapSchema.safeParse({
      global: {},
      repos: { r1: { development: "INVALID" } },
    });
    expect(result.success).toBe(false);
  });
});

describe("SecretSchema — status field", () => {
  it("accepts a secret without status (backwards compat)", () => {
    const result = SecretSchema.safeParse({
      id: "abc",
      key: "MY_KEY",
      value: "val",
      scopes: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects status: 'active' (removed from enum)", () => {
    const result = SecretSchema.safeParse({
      id: "abc",
      key: "MY_KEY",
      value: "val",
      scopes: [],
      status: "active",
    });
    expect(result.success).toBe(false);
  });

  it("accepts status: 'awaiting_value'", () => {
    const result = SecretSchema.safeParse({
      id: "abc",
      key: "MY_KEY",
      value: "",
      scopes: [],
      status: "awaiting_value",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an unknown status string", () => {
    const result = SecretSchema.safeParse({
      id: "abc",
      key: "MY_KEY",
      value: "val",
      scopes: [],
      status: "pending",
    });
    expect(result.success).toBe(false);
  });
});
