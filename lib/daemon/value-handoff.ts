import { readFile, unlink } from "node:fs/promises";

/**
 * Read a plaintext value out of `path` and produce an unlinker.
 *
 * The caller flow is always:
 *   const { value, unlink } = await readValueFromFile(path);
 *   try { ...persist with value...; }
 *   finally { await unlink(); }
 *
 * That way the temp file is removed even on persistence failure. We also
 * make a best-effort attempt to keep the value out of swap via `mlock`,
 * but `mlock` is not portable and unprivileged Node on macOS will silently
 * fail; we don't block on it.
 */
export type ValueHandoff = {
  value: string;
  /** Remove the source temp file. Idempotent and best-effort. */
  unlink: () => Promise<void>;
  /** True if a best-effort mlock-style call succeeded. Informational. */
  mlocked: boolean;
};

export async function readValueFromFile(path: string): Promise<ValueHandoff> {
  const buf = await readFile(path);
  const mlocked = tryMlock(buf);
  const value = buf.toString("utf8");
  let unlinked = false;
  const unlinkOnce = async () => {
    if (unlinked) return;
    unlinked = true;
    try {
      await unlink(path);
    } catch {
      // Best-effort cleanup.
    }
  };
  return { value, unlink: unlinkOnce, mlocked };
}

/**
 * Try to lock the given buffer's memory pages. Returns false instead of
 * throwing if the platform doesn't support it or perms don't allow.
 *
 * On macOS without privileged Node this typically returns false. The vault
 * encryption pipeline still protects the value at rest; this is a defense
 * in depth.
 */
function tryMlock(_buf: Buffer): boolean {
  // Node has no built-in mlock; the system call would need an addon. Stub
  // returns false so the API is shaped for v0.3 when we add an opt-in
  // native addon, without forcing the caller to do feature-detection.
  return false;
}
