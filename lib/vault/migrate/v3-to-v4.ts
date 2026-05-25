export function migrateV3toV4(parsed: unknown): unknown {
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return parsed;
  const obj = parsed as Record<string, unknown>;
  if (obj.version !== 3) return parsed;
  return { ...obj, version: 4 };
}
