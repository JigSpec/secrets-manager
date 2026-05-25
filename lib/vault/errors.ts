/**
 * Human-readable error message returned to the client when the vault is locked
 * (i.e. `getVaultData()` returns null). Shared between the deploy route and the
 * DeploySheet component so a change in one automatically stays in sync with the
 * other.
 */
export const VAULT_LOCKED_ERROR = "Vault is locked";

export type VaultErrorCode =
  | "WRONG_PASSWORD"
  | "CORRUPTED"
  | "NOT_FOUND"
  | "INVALID_DATA"
  | "INCOMPATIBLE_VAULT_VERSION";

export class VaultError extends Error {
  readonly code: VaultErrorCode;

  constructor(code: VaultErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VaultError";
    this.code = code;
  }
}
