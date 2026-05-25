import { z } from "zod";

const nonEmptyString = z.string().min(1);

// Shared base for lowercase identifier types (namespace and variant).
// Regex: must start with a-z, followed by zero or more a-z0-9, max 32 chars.
export const LowercaseIdentifierSchema = z
  .string()
  .regex(/^[a-z][a-z0-9]*$/)
  .min(1)
  .max(32);

export const RepoSchema = z.object({
  id: nonEmptyString,
  name: nonEmptyString,
  path: nonEmptyString,
  environments: z
    .array(nonEmptyString)
    .transform((envs) => Array.from(new Set(envs))),
});

export const ScopeSchema = z.object({
  repoId: nonEmptyString,
  env: nonEmptyString,
});

// NamespaceSchema and VariantSchema intentionally share LowercaseIdentifierSchema
// as their base — they are kept as separate named exports so that call sites and
// error messages remain semantically distinct even though the validation rules
// are currently identical.
export const NamespaceSchema = LowercaseIdentifierSchema;

export const VariantSchema = LowercaseIdentifierSchema;

export const SecretKeySchema = z
  .string()
  .regex(/^[A-Z_][A-Z0-9_]*$/);

export const SecretStatusSchema = z.enum(["awaiting_value"]);
export type SecretStatus = z.infer<typeof SecretStatusSchema>;

export const SecretFlavorSchema = z.object({
  flavor: z.enum(["test", "live", "local", "unknown"]),
  confidence: z.enum(["high", "low"]),
  provider: z.enum(["stripe", "github", "openai", "anthropic", "slack", "twilio", "aws", "jwt", "postgres", "unknown"]),
  reason: z.string(),
});

export const TutorialStepSchema = z.object({
  order: z.number().int().min(0),
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  link: z.string().url().optional(),
});

export const TutorialSchema = z.object({
  steps: z.array(TutorialStepSchema).min(1).max(20),
  createdAt: z.string().datetime(),
  mayBeStale: z.boolean().optional(),
  authorAgent: z.string().max(100).optional(),
});

export type TutorialStep = z.infer<typeof TutorialStepSchema>;
export type Tutorial = z.infer<typeof TutorialSchema>;

export const SecretSchema = z.object({
  id: nonEmptyString,
  key: SecretKeySchema,
  value: z.string(),
  namespace: NamespaceSchema.optional(),
  variant: VariantSchema.optional(),
  scopes: z.array(ScopeSchema),
  flavor: SecretFlavorSchema.optional(),
  description: z.string().min(1).max(500).optional(),
  tutorial: TutorialSchema.optional(),
  status: SecretStatusSchema.optional(),
});

// Per-repo variant overrides: env → variant (validated against VariantSchema)
export const RepoVariantOverridesSchema = z.record(z.string(), VariantSchema);

export const EnvVariantMapSchema = z.object({
  global: z.record(z.string(), VariantSchema),
  repos: z.record(z.string(), RepoVariantOverridesSchema),
});

export const VaultDataV2Schema = z.object({
  version: z.literal(2),
  repos: z.array(RepoSchema),
  secrets: z.array(SecretSchema),
});

export const VaultDataV3Schema = z.object({
  version: z.literal(3),
  repos: z.array(RepoSchema),
  secrets: z.array(SecretSchema),
  envVariantMap: EnvVariantMapSchema,
});

export const VaultDataV4Schema = z.object({
  version: z.literal(4),
  repos: z.array(RepoSchema),
  secrets: z.array(SecretSchema),
  envVariantMap: EnvVariantMapSchema,
});

export const VaultDataSchema = z.discriminatedUnion("version", [
  VaultDataV2Schema,
  VaultDataV3Schema,
  VaultDataV4Schema,
]);

export type Repo = z.infer<typeof RepoSchema>;
export type Scope = z.infer<typeof ScopeSchema>;
export type Secret = z.infer<typeof SecretSchema>;
export type VaultData = z.infer<typeof VaultDataSchema>;
export type VaultDataV2 = z.infer<typeof VaultDataV2Schema>;
export type VaultDataV3 = z.infer<typeof VaultDataV3Schema>;
export type VaultDataV4 = z.infer<typeof VaultDataV4Schema>;
export type Variant = z.infer<typeof VariantSchema>;
export type EnvVariantMap = z.infer<typeof EnvVariantMapSchema>;

/**
 * Outbound-only metadata view of a Secret — never carries `value`. The daemon
 * serializes this type on the socket; never `Secret`.
 */
export type SecretMetadata = Omit<Secret, "value">;
