/**
 * tests/vault/description.test.ts
 *
 * Tests for issue #27 — optional `description` field on secrets.
 */

import { describe, expect, it } from "vitest";

import { SecretSchema } from "@/lib/vault/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A minimal valid secret payload (no description). */
const BASE_SECRET = {
  id: "abc12345",
  key: "MY_SECRET_KEY",
  value: "s3cr3t-v@lue",
  scopes: [],
} as const;

// ---------------------------------------------------------------------------
// SecretSchema — description field
// ---------------------------------------------------------------------------

describe("SecretSchema — description field", () => {
  it("accepts a secret with a non-empty description string", () => {
    const result = SecretSchema.parse({
      ...BASE_SECRET,
      description: "Primary database connection URL for the app",
    });

    expect(result.description).toBe("Primary database connection URL for the app");
  });

  it("preserves description in the round-trip output object", () => {
    const input = {
      ...BASE_SECRET,
      description: "Stripe live-mode publishable key",
    };

    const result = SecretSchema.parse(input);

    expect(result).toMatchObject({
      id: BASE_SECRET.id,
      key: BASE_SECRET.key,
      description: "Stripe live-mode publishable key",
    });
  });

  it("accepts description: undefined (field is optional)", () => {
    // Omitting description is valid — the field is optional.
    const result = SecretSchema.parse({ ...BASE_SECRET, description: undefined });

    expect(result.description).toBeUndefined();
  });

  it("a secret parsed without description has description as undefined", () => {
    // Backward-compat: existing secrets stored without the field must still
    // parse correctly and expose `undefined` for description.
    const result = SecretSchema.parse(BASE_SECRET);

    expect(result.description).toBeUndefined();
  });

  it("rejects a secret whose description is not a string", () => {
    // description: z.string() must reject a number.
    const result = SecretSchema.safeParse({
      ...BASE_SECRET,
      description: 42,
    });

    expect(result.success).toBe(false);
  });

  it("rejects an empty description string (use undefined to clear)", () => {
    // Empty string is not a valid description — use undefined (omit the field) to clear.
    // This is consistent with how actions and handlers treat empty string as "delete".
    const result = SecretSchema.safeParse({ ...BASE_SECRET, description: "" });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SecretInputSchema (app/actions.ts) — description field
// ---------------------------------------------------------------------------
// SecretInputSchema is not exported, so we test at the SecretSchema level,
// which is the authoritative source of truth for the stored shape.

describe("SecretSchema — TypeScript type carries description", () => {
  it("parsed Secret type includes optional description property", () => {
    // Compile-time + runtime check: TypeScript will fail to compile if
    // `description` is not on the type; the runtime assertion verifies the value.
    const result = SecretSchema.parse({
      ...BASE_SECRET,
      description: "Human-readable label for this secret",
    });

    expect(result.description).toBe("Human-readable label for this secret");
  });
});

// ---------------------------------------------------------------------------
// describe-secret handler — description survives the metadata projection
// ---------------------------------------------------------------------------
// The handler does: const { value, ...rest } = match;
// Once `description` is in SecretSchema it will automatically appear in `rest`
// and therefore in SecretMetadata.  These tests validate that contract.

describe("SecretMetadata — description is included, value is excluded", () => {
  it("SecretSchema output contains description but not value after projection", () => {
    // Simulate what describe-secret does: parse a full secret, then spread
    // without `value`. The description must survive.
    const parsed = SecretSchema.parse({
      ...BASE_SECRET,
      description: "OAuth client secret for the admin console",
    });

    // Mimic the handler's projection
    const { value: _value, ...metadata } = parsed as typeof parsed & { value: string };

    expect(metadata).not.toHaveProperty("value");
    expect((metadata as Record<string, unknown>).description).toBe(
      "OAuth client secret for the admin console",
    );
  });

  it("SecretMetadata projection omits value even when description is present", () => {
    const parsed = SecretSchema.parse({
      ...BASE_SECRET,
      description: "Webhook signing secret",
    });

    const { value: _omitted, ...metadata } = parsed as typeof parsed & { value: string };

    // value must not leak into metadata
    expect(Object.keys(metadata)).not.toContain("value");

    // description must be present
    expect((metadata as Record<string, unknown>).description).toBeDefined();
  });
});
