import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { generateSecretId } from "../id";
import { NamespaceSchema, SecretKeySchema, ScopeSchema, VariantSchema, TutorialSchema, type Secret, type Tutorial } from "../../vault/schema";
import { formatZodError } from "../../vault/zod-format";
import { z } from "zod";
import { readValueFromFile } from "../value-handoff";
import { planAutoScope, applyAutoScope } from "../../vault/variant/auto-scope";
import { classifySecret } from "../../vault/classify";
import { isSentinelValue, isDotenvxReservedKey } from "../../vault/sentinel";

registerHandler("add-secret", async (args) => {
  const keyParsed = SecretKeySchema.safeParse(args.key);
  if (!keyParsed.success) {
    return err(
      "INVALID_INPUT",
      "`key` must match /^[A-Z_][A-Z0-9_]*$/ (uppercase only)",
    );
  }
  if (isDotenvxReservedKey(keyParsed.data)) {
    return err(
      "INVALID_INPUT",
      `"${keyParsed.data}" is a dotenvx-internal key (matches DOTENV_(PUBLIC|PRIVATE)_KEY_*) and must not be stored in the vault.`,
    );
  }
  let namespace: string | undefined;
  if (args.namespace !== undefined) {
    if (typeof args.namespace !== "string") {
      return err("INVALID_INPUT", "`namespace` must be a string");
    }
    const ns = NamespaceSchema.safeParse(args.namespace);
    if (!ns.success) {
      return err(
        "INVALID_INPUT",
        "namespace must be lowercase ascii letters/digits, max 32 chars",
      );
    }
    namespace = ns.data;
  }
  let variant: string | undefined;
  if (args.variant !== undefined) {
    if (typeof args.variant !== "string") {
      return err("INVALID_INPUT", "`variant` must be a string");
    }
    const v = VariantSchema.safeParse(args.variant);
    if (!v.success) {
      return err(
        "INVALID_INPUT",
        "variant must start with a lowercase letter and contain only lowercase letters/digits, max 32 chars",
      );
    }
    variant = v.data;
  }
  let description: string | undefined;
  if (args.description !== undefined) {
    if (typeof args.description !== "string") {
      return err("INVALID_INPUT", "`description` must be a string");
    }
    if (args.description.length > 500) {
      return err("INVALID_INPUT", "`description` must be 500 characters or fewer");
    }
    description = args.description;
  }
  let tutorial: Tutorial | undefined;
  if (args.tutorial !== undefined) {
    const parsed = TutorialSchema.safeParse(args.tutorial);
    if (!parsed.success) {
      return err("INVALID_INPUT", `invalid tutorial: ${formatZodError(parsed.error)}`);
    }
    tutorial = parsed.data;
  }
  if (typeof args.valuePath !== "string" || args.valuePath.length === 0) {
    return err("INVALID_INPUT", "`valuePath` (file containing the value) is required");
  }

  const { data } = currentSessionData();
  // When variant is explicitly set, the (key, namespace, variant) triple is an
  // identity — duplicate triples are rejected. Without variant, duplicates are
  // allowed; the disjoint-scope invariant is enforced at scope/auto-scope time.
  if (variant !== undefined) {
    const conflict = data.secrets.some(
      (s) =>
        s.key === keyParsed.data &&
        (s.namespace ?? undefined) === (namespace ?? undefined) &&
        s.variant === variant,
    );
    if (conflict) {
      return err(
        "CONFLICT",
        `secret "${keyParsed.data}"${namespace ? ` in namespace "${namespace}"` : ""} with variant "${variant}" already exists`,
      );
    }
  }

  let handoff;
  try {
    handoff = await readValueFromFile(args.valuePath);
  } catch (e) {
    return err(
      "INVALID_INPUT",
      `could not read value file: ${(e as Error).message ?? "unknown error"}`,
    );
  }

  // Check for an existing awaiting_value placeholder to upsert into.
  const placeholderIdx = data.secrets.findIndex(
    (s) =>
      s.status === "awaiting_value" &&
      s.key === keyParsed.data &&
      (s.namespace ?? undefined) === (namespace ?? undefined),
  );
  const isUpsert = placeholderIdx !== -1;

  // Validate args.scopes if provided so we have a properly-typed value.
  let parsedScopes: z.infer<typeof ScopeSchema>[] | undefined;
  if (args.scopes !== undefined) {
    const scopesParsed = z.array(ScopeSchema).safeParse(args.scopes);
    if (!scopesParsed.success) {
      return err("INVALID_INPUT", `invalid scopes: ${scopesParsed.error.issues[0]?.message ?? "bad shape"}`);
    }
    parsedScopes = scopesParsed.data;
  }

  if (isSentinelValue(handoff.value)) {
    await handoff.unlink();
    return err(
      "INVALID_INPUT",
      "value appears to be a placeholder sentinel (e.g. TODO, PLACEHOLDER, <YOUR_KEY>). Use `set_tutorial` to create an awaiting_value placeholder instead.",
    );
  }

  try {
    const flavor = classifySecret(handoff.value);

    let secret: Secret;
    if (isUpsert) {
      const placeholder = data.secrets[placeholderIdx]!;
      const { status: _status, ...placeholderRest } = placeholder;
      secret = {
        ...placeholderRest,
        value: handoff.value,
        flavor,
        ...(namespace !== undefined ? { namespace } : {}),
        ...(variant !== undefined ? { variant } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(tutorial !== undefined ? { tutorial } : {}),
        ...(parsedScopes !== undefined ? { scopes: parsedScopes } : {}),
      };
    } else {
      secret = {
        id: generateSecretId(),
        key: keyParsed.data,
        value: handoff.value,
        scopes: [],
        flavor,
        ...(namespace !== undefined ? { namespace } : {}),
        ...(variant !== undefined ? { variant } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(tutorial !== undefined ? { tutorial } : {}),
      };
    }

    let skippedVariants: { repoId: string; env: string; siblingId?: string }[] = [];
    if (variant !== undefined) {
      const plan = planAutoScope(secret, data);
      secret = applyAutoScope(secret, plan);
      skippedVariants = plan
        .filter((c): c is Extract<typeof c, { action: "skip-sibling-conflict" }> =>
          c.action === "skip-sibling-conflict",
        )
        .map((c) => ({
          repoId: c.cell.repoId,
          env: c.cell.env,
          ...(c.siblingId !== undefined ? { siblingId: c.siblingId } : {}),
        }));
    }

    let updatedSecrets: Secret[];
    if (isUpsert) {
      updatedSecrets = data.secrets.map((s, i) => (i === placeholderIdx ? secret : s));
    } else {
      updatedSecrets = [...data.secrets, secret];
    }

    const next = { ...data, secrets: updatedSecrets };
    await persistData(next);
    return ok({
      secret: {
        id: secret.id,
        key: secret.key,
        scopes: secret.scopes,
        flavor: secret.flavor,
        ...(namespace !== undefined ? { namespace } : {}),
        ...(variant !== undefined ? { variant } : {}),
        ...(description !== undefined ? { description } : {}),
        ...(tutorial !== undefined ? { tutorial } : {}),
      },
      ...(isUpsert ? { upserted: true } : {}),
      ...(skippedVariants.length > 0 ? { skippedVariants } : {}),
    });
  } finally {
    await handoff.unlink();
  }
});
