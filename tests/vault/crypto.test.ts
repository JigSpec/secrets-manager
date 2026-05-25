import { describe, expect, it } from "vitest";

import {
  ENVELOPE_VERSION,
  NONCE_LENGTH,
  SALT_LENGTH,
  TAG_LENGTH,
  decryptVault,
  deriveKey,
  encryptVault,
  generateSalt,
  parseBlob,
  serializeBlob,
} from "@/lib/vault/crypto";

const TEST_PASSWORD = "correct horse battery staple";

describe("crypto round-trip", () => {
  const payloads: Array<{ label: string; value: string }> = [
    { label: "ascii", value: "hello world" },
    { label: "json", value: JSON.stringify({ a: 1, b: [2, 3], c: "x" }) },
    { label: "unicode", value: "héllo 🚀 — 漢字 — مرحبا" },
    { label: "empty", value: "" },
    { label: "long", value: "x".repeat(10_000) },
  ];

  for (const { label, value } of payloads) {
    it(`encrypt → decrypt preserves "${label}" payload`, async () => {
      const salt = generateSalt();
      const key = await deriveKey(TEST_PASSWORD, salt);
      const blob = encryptVault(value, key);
      expect(blob.nonce).toHaveLength(NONCE_LENGTH);
      expect(blob.tag).toHaveLength(TAG_LENGTH);
      const out = decryptVault(blob, key);
      expect(out).toBe(value);
    });
  }
});

describe("envelope round-trip", () => {
  it("serializeBlob → parseBlob recovers identical buffers", async () => {
    const salt = generateSalt();
    expect(salt).toHaveLength(SALT_LENGTH);
    const key = await deriveKey(TEST_PASSWORD, salt);
    const { nonce, ciphertext, tag } = encryptVault("payload", key);
    const serialized = serializeBlob(salt, nonce, ciphertext, tag);

    expect(serialized.startsWith(`${ENVELOPE_VERSION}:`)).toBe(true);
    const parsed = parseBlob(serialized);
    expect(parsed.salt.equals(salt)).toBe(true);
    expect(parsed.nonce.equals(nonce)).toBe(true);
    expect(parsed.ciphertext.equals(ciphertext)).toBe(true);
    expect(parsed.tag.equals(tag)).toBe(true);
  });
});

describe("parseBlob rejects malformed input", () => {
  function buildValidEnvelope(): string {
    const salt = generateSalt();
    const nonce = Buffer.alloc(NONCE_LENGTH, 7);
    const tag = Buffer.alloc(TAG_LENGTH, 9);
    const ciphertext = Buffer.from("ciphertext-bytes");
    return serializeBlob(salt, nonce, ciphertext, tag);
  }

  it("rejects unknown version prefix", () => {
    const valid = buildValidEnvelope();
    const tampered = `v2:${valid.split(":").slice(1).join(":")}`;
    expect(() => parseBlob(tampered)).toThrow(/version/u);
  });

  it("rejects wrong part count (too few)", () => {
    expect(() => parseBlob("v1:abc:def")).toThrow(/parts/u);
  });

  it("rejects wrong part count (too many)", () => {
    const valid = buildValidEnvelope();
    expect(() => parseBlob(`${valid}:extra`)).toThrow(/parts/u);
  });

  it("rejects non-base64 segments", () => {
    const salt = generateSalt().toString("base64");
    const nonce = Buffer.alloc(NONCE_LENGTH).toString("base64");
    const tag = Buffer.alloc(TAG_LENGTH).toString("base64");
    const bad = `v1:${salt}:${nonce}:!!!not-base64!!!:${tag}`;
    expect(() => parseBlob(bad)).toThrow(/base64/u);
  });

  it("rejects empty string", () => {
    expect(() => parseBlob("")).toThrow();
  });

  it("rejects segments of wrong byte length", () => {
    const shortSalt = Buffer.alloc(SALT_LENGTH - 1).toString("base64");
    const nonce = Buffer.alloc(NONCE_LENGTH).toString("base64");
    const tag = Buffer.alloc(TAG_LENGTH).toString("base64");
    const cipher = Buffer.from("xxx").toString("base64");
    const bad = `v1:${shortSalt}:${nonce}:${cipher}:${tag}`;
    expect(() => parseBlob(bad)).toThrow(/length/u);
  });
});

describe("decryptVault rejects tampering", () => {
  it("throws when auth tag is flipped", async () => {
    const salt = generateSalt();
    const key = await deriveKey(TEST_PASSWORD, salt);
    const blob = encryptVault("payload", key);
    const tampered = Buffer.from(blob.tag);
    tampered[0] = tampered[0] ^ 0x01;
    expect(() =>
      decryptVault({ ...blob, tag: tampered }, key),
    ).toThrow();
  });

  it("throws when ciphertext is flipped", async () => {
    const salt = generateSalt();
    const key = await deriveKey(TEST_PASSWORD, salt);
    const blob = encryptVault("payload with enough data", key);
    const tampered = Buffer.from(blob.ciphertext);
    tampered[0] = tampered[0] ^ 0xff;
    expect(() =>
      decryptVault({ ...blob, ciphertext: tampered }, key),
    ).toThrow();
  });

  it("throws when nonce is flipped", async () => {
    const salt = generateSalt();
    const key = await deriveKey(TEST_PASSWORD, salt);
    const blob = encryptVault("payload", key);
    const tampered = Buffer.from(blob.nonce);
    tampered[0] = tampered[0] ^ 0xaa;
    expect(() =>
      decryptVault({ ...blob, nonce: tampered }, key),
    ).toThrow();
  });
});
