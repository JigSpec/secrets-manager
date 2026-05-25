import { randomBytes } from "node:crypto";

export function generateSecretId(): string {
  return randomBytes(8).toString("hex");
}
