import { registerHandler, currentSessionData } from "../server";
import { persistData } from "../session";
import { err, ok } from "../protocol";
import { generateSecretId } from "../id";
import { findSecretOrAmbiguous } from "./_resolve";
import { TutorialSchema, SecretKeySchema } from "../../vault/schema";
import { formatZodError } from "../../vault/zod-format";
import type { Secret } from "../../vault/schema";

registerHandler("set-tutorial", async (args) => {
  if (typeof args.secret !== "string" || args.secret.length === 0) {
    return err("INVALID_INPUT", "`secret` (id or key) is required");
  }

  // ── Step 1: validate the tutorial/unset args BEFORE touching any state ──
  if (args.unset === true && args.tutorial !== undefined) {
    return err("INVALID_INPUT", "provide either `tutorial` or `unset: true`, not both");
  }
  if (args.unset !== true && args.tutorial === undefined) {
    return err("INVALID_INPUT", "either `tutorial` or `unset: true` is required");
  }

  // If setting a tutorial, validate it up-front so we never create a dangling
  // placeholder on validation failure.
  let parsedTutorial: ReturnType<typeof TutorialSchema.safeParse> | undefined;
  if (args.tutorial !== undefined) {
    parsedTutorial = TutorialSchema.safeParse(args.tutorial);
    if (!parsedTutorial.success) {
      return err("INVALID_INPUT", `invalid tutorial: ${formatZodError(parsedTutorial.error)}`);
    }
  }

  let parsedDescription: string | undefined;
  if (args.description !== undefined) {
    if (typeof args.description !== "string" || args.description.length === 0) {
      return err("INVALID_INPUT", "`description` must be a non-empty string");
    }
    if (args.description.length > 500) {
      return err("INVALID_INPUT", "`description` must be 500 characters or fewer");
    }
    parsedDescription = args.description;
  }

  // ── Step 2: resolve or create the secret ────────────────────────────────
  const { data } = currentSessionData();
  const secretOrAmb = findSecretOrAmbiguous(data, args.secret);

  let secret: Secret;
  let isNewPlaceholder = false;

  if (!secretOrAmb) {
    // Secret not found — try to auto-create a placeholder if key is valid.
    if (args.unset === true) {
      return err("NOT_FOUND", `secret "${args.secret}" not found`);
    }
    const keyParsed = SecretKeySchema.safeParse(args.secret);
    if (!keyParsed.success) {
      return err("NOT_FOUND", `secret "${args.secret}" not found`);
    }
    // Valid key and tutorial already validated above — safe to create placeholder.
    secret = {
      id: generateSecretId(),
      key: keyParsed.data,
      value: "",
      scopes: [],
      status: "awaiting_value",
      ...(parsedDescription !== undefined ? { description: parsedDescription } : {}),
    };
    isNewPlaceholder = true;
  } else if (secretOrAmb === "AMBIGUOUS") {
    return err("AMBIGUOUS", `multiple secrets share key "${args.secret}" — use the secret id instead`);
  } else {
    secret = secretOrAmb;
  }

  // ── Step 3: apply the mutation and persist ───────────────────────────────
  let updated: Secret;
  if (args.unset === true) {
    // Remove the tutorial field.
    const { tutorial: _tutorial, ...rest } = secret;
    updated = rest;
  } else {
    // parsedTutorial is guaranteed to be defined and successful here.
    updated = {
      ...secret,
      tutorial: parsedTutorial!.data,
      ...(parsedDescription !== undefined ? { description: parsedDescription } : {}),
    };
  }

  let secrets: Secret[];
  if (isNewPlaceholder) {
    secrets = [...data.secrets, updated];
  } else {
    secrets = data.secrets.map((s) => (s.id === secret.id ? updated : s));
  }
  await persistData({ ...data, secrets });

  const { value: _value, ...metadata } = updated;
  return ok({ secret: metadata, created: isNewPlaceholder });
});
