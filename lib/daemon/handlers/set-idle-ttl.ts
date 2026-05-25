import { registerHandler } from "../server";
import { err, ok } from "../protocol";
import {
  MAX_IDLE_TTL_MIN,
  MIN_IDLE_TTL_MIN,
  clampTtlMin,
  loadDaemonConfig,
  saveDaemonConfig,
} from "../config";

registerHandler("set-idle-ttl", async (args, ctx) => {
  const minutes = args.minutes;
  if (typeof minutes !== "number" || !Number.isFinite(minutes)) {
    return err("INVALID_INPUT", "`minutes` (number) is required");
  }
  if (minutes < MIN_IDLE_TTL_MIN || minutes > MAX_IDLE_TTL_MIN) {
    return err(
      "INVALID_INPUT",
      `\`minutes\` must be between ${MIN_IDLE_TTL_MIN} and ${MAX_IDLE_TTL_MIN}`,
    );
  }

  const clamped = clampTtlMin(minutes);
  const nextMs = clamped * 60_000;

  // Persist to the daemon-config file so the value survives restarts.
  // Preserve any other keys already in the file.
  const existing = await loadDaemonConfig();
  try {
    await saveDaemonConfig({ ...existing, idleTtlMin: clamped });
  } catch (e) {
    return err(
      "PERSIST_FAILED",
      `failed to persist daemon config: ${(e as Error).message ?? String(e)}`,
    );
  }

  // Apply to the running daemon. Re-arms the idle timer immediately.
  ctx.setIdleTtlMs(nextMs);

  return ok({
    idleTtlMin: clamped,
    idleTtlMs: nextMs,
  });
});
