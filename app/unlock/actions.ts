"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import {
  createVaultWithPassword,
  unlockWithPassword,
  vaultIsInitialized,
  lock,
} from "@/lib/vault/session";
import { VaultError } from "@/lib/vault/store";

const UnlockSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

const CreateSchema = z
  .object({
    password: z.string().min(8, "Password must be at least 8 characters"),
    confirm: z.string().min(1, "Confirm your password"),
  })
  .refine((d) => d.password === d.confirm, {
    message: "Passwords do not match",
    path: ["confirm"],
  });

export type UnlockState =
  | { ok: true }
  | { ok: false; error: string };

export async function unlockAction(
  _prev: UnlockState,
  formData: FormData,
): Promise<UnlockState> {
  const exists = await vaultIsInitialized();
  if (!exists) {
    return { ok: false, error: "No vault exists yet. Create one." };
  }
  const parsed = UnlockSchema.safeParse({
    password: formData.get("password"),
  });
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  try {
    await unlockWithPassword(parsed.data.password);
  } catch (err) {
    if (err instanceof VaultError) {
      if (err.code === "WRONG_PASSWORD") {
        return {
          ok: false,
          error:
            "Wrong password. If you have forgotten your password, the vault cannot be recovered without it.",
        };
      }
      if (err.code === "CORRUPTED") {
        return {
          ok: false,
          error: "Vault file is corrupted. Restore from backup or delete to start over.",
        };
      }
      if (err.code === "INVALID_DATA") {
        return {
          ok: false,
          error:
            "Vault schema is invalid — the decrypted vault does not match the expected shape for this build. Check the server log for details.",
        };
      }
      if (err.code === "NOT_FOUND") {
        return { ok: false, error: "Vault not found." };
      }
      if (err.code === "INCOMPATIBLE_VAULT_VERSION") {
        return {
          ok: false,
          error:
            "This vault was written by a newer build of secrets-manager. Upgrade or check out the matching version, then retry.",
        };
      }
    }
    // Surface unexpected errors (non-VaultError, or a VaultError code that
    // this branch ladder doesn't recognise) to the server log so they can
    // be diagnosed instead of disappearing into the generic message below.
    console.error("[unlockAction] unexpected error during unlock", err);
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to unlock: ${detail}` };
  }
  redirect("/");
}

export async function createAction(
  _prev: UnlockState,
  formData: FormData,
): Promise<UnlockState> {
  const exists = await vaultIsInitialized();
  if (exists) {
    return {
      ok: false,
      error: "A vault already exists. Use the enter password form.",
    };
  }
  const parsed = CreateSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });
  if (!parsed.success) {
    return {
      ok: false,
      error: parsed.error.issues[0]?.message ?? "Invalid input",
    };
  }
  try {
    await createVaultWithPassword(parsed.data.password);
  } catch (err) {
    console.error("[createAction] unexpected error during vault creation", err);
    const detail = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `Failed to create vault: ${detail}` };
  }
  redirect("/");
}

export async function clearSessionAction(): Promise<void> {
  await lock();
  redirect("/unlock");
}
