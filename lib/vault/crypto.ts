import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt,
} from "node:crypto";

export const SCRYPT_N = 2 ** 17;
export const SCRYPT_R = 8;
export const SCRYPT_P = 1;
export const KEY_LENGTH = 32;
export const SCRYPT_MAXMEM = 256 * 1024 * 1024;

export const SALT_LENGTH = 16;
export const NONCE_LENGTH = 12;
export const TAG_LENGTH = 16;

export const ENVELOPE_VERSION = "v1";
const ENVELOPE_PART_COUNT = 5;

export type EncryptedBlob = {
  nonce: Buffer;
  ciphertext: Buffer;
  tag: Buffer;
};

export type ParsedEnvelope = EncryptedBlob & { salt: Buffer };

export function deriveKey(password: string, salt: Buffer): Promise<Buffer> {
  // Allow tests to override N at call time via env var to avoid multi-second
  // scrypt waits in integration test suites. SM_SCRYPT_N=1024 is safe for
  // tests but must never be used in production (2^17 is the security floor).
  const N =
    process.env.SM_SCRYPT_N !== undefined
      ? Number(process.env.SM_SCRYPT_N)
      : SCRYPT_N;
  return new Promise((resolve, reject) => {
    scrypt(
      password,
      salt,
      KEY_LENGTH,
      {
        N,
        r: SCRYPT_R,
        p: SCRYPT_P,
        maxmem: SCRYPT_MAXMEM,
      },
      (err, derivedKey) => {
        if (err) {
          reject(err);
          return;
        }
        resolve(derivedKey);
      },
    );
  });
}

export function encryptVault(plaintext: string, key: Buffer): EncryptedBlob {
  const nonce = randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return { nonce, ciphertext, tag };
}

export function decryptVault(blob: EncryptedBlob, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, blob.nonce);
  decipher.setAuthTag(blob.tag);
  const plaintext = Buffer.concat([
    decipher.update(blob.ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString("utf8");
}

export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH);
}

export function serializeBlob(
  salt: Buffer,
  nonce: Buffer,
  ciphertext: Buffer,
  tag: Buffer,
): string {
  return [
    ENVELOPE_VERSION,
    salt.toString("base64"),
    nonce.toString("base64"),
    ciphertext.toString("base64"),
    tag.toString("base64"),
  ].join(":");
}

function isBase64(value: string): boolean {
  // Allow empty string — a 0-byte buffer serialises as ""
  if (value.length === 0) return true;
  return /^[A-Za-z0-9+/]*={0,2}$/.test(value);
}

function decodeBase64Strict(value: string, expectedLength?: number): Buffer {
  if (!isBase64(value)) {
    throw new Error("envelope segment is not valid base64");
  }
  if (value.length === 0) {
    // Empty base64 encodes a zero-length buffer (valid for ciphertext only;
    // expectedLength guards will catch misuse for salt/nonce/tag).
    if (expectedLength !== undefined && expectedLength !== 0) {
      throw new Error(
        `envelope segment has unexpected length 0, expected ${expectedLength}`,
      );
    }
    return Buffer.alloc(0);
  }
  const buf = Buffer.from(value, "base64");
  if (buf.toString("base64").replace(/=+$/u, "") !== value.replace(/=+$/u, "")) {
    throw new Error("envelope segment is not canonical base64");
  }
  if (expectedLength !== undefined && buf.length !== expectedLength) {
    throw new Error(
      `envelope segment has unexpected length ${buf.length}, expected ${expectedLength}`,
    );
  }
  return buf;
}

export function parseBlob(blob: string): ParsedEnvelope {
  if (typeof blob !== "string" || blob.length === 0) {
    throw new Error("envelope is empty");
  }
  const parts = blob.split(":");
  if (parts.length !== ENVELOPE_PART_COUNT) {
    throw new Error(
      `envelope has ${parts.length} parts, expected ${ENVELOPE_PART_COUNT}`,
    );
  }
  const [version, saltB64, nonceB64, ciphertextB64, tagB64] = parts;
  if (version !== ENVELOPE_VERSION) {
    throw new Error(`unknown envelope version: ${version}`);
  }
  const salt = decodeBase64Strict(saltB64, SALT_LENGTH);
  const nonce = decodeBase64Strict(nonceB64, NONCE_LENGTH);
  const ciphertext = decodeBase64Strict(ciphertextB64);
  const tag = decodeBase64Strict(tagB64, TAG_LENGTH);
  return { salt, nonce, ciphertext, tag };
}
