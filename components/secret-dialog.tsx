"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Eye, EyeOff } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { Secret } from "@/lib/vault/schema";

type FormShape = {
  key: string;
  value: string;
  namespace?: string;
  variant?: string;
  description?: string;
};
type SubmitResult = { ok: true } | { error: string };

export function SecretDialog({
  open,
  onOpenChange,
  initialSecret,
  duplicateSource,
  onSubmit,
  busy,
  defaultNamespace,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  initialSecret: Secret | null;
  duplicateSource?: Secret | null;
  onSubmit: (form: FormShape) => Promise<SubmitResult>;
  busy?: boolean;
  defaultNamespace?: string;
}) {
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [namespace, setNamespace] = useState("");
  const [variant, setVariant] = useState("");
  const [description, setDescription] = useState("");
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const prevOpenRef = useRef(false);

  const mode: "new" | "edit" | "duplicate" =
    initialSecret ? "edit" : duplicateSource ? "duplicate" : "new";

  useEffect(() => {
    // Only reset form state on the false→true transition of `open`.
    // Gating on the transition (rather than on `open` being truthy) prevents a
    // parent re-render that changes `defaultNamespace` while the dialog is already
    // open from silently wiping the user's in-progress edits.
    if (open && !prevOpenRef.current) {
      const source = initialSecret ?? duplicateSource;
      setKey(source?.key ?? "");
      setValue(source?.value ?? "");
      // Default namespace only applies when opening in "new" mode (no source).
      setNamespace(source !== null && source !== undefined ? (source.namespace ?? "") : (defaultNamespace ?? ""));
      setVariant(source?.variant ?? "");
      setDescription(source?.description ?? "");
      setReveal(false);
      setError(null);
    }
    prevOpenRef.current = open;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    // `defaultNamespace` is intentionally excluded: including it would reset
    // in-progress edits whenever the parent re-renders with a new string value
    // while the dialog is already open. The prevOpenRef gate above ensures the
    // value is captured exactly once — when the dialog transitions to open.
  }, [open, initialSecret, duplicateSource]);

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!key.trim()) {
      setError("Key is required.");
      return;
    }
    if (mode === "duplicate" && duplicateSource) {
      const nsChanged = namespace.trim() !== (duplicateSource.namespace ?? "").trim();
      const variantChanged = variant.trim() !== (duplicateSource.variant ?? "").trim();
      const keyChanged = key.trim() !== duplicateSource.key.trim();
      if (!nsChanged && !variantChanged && !keyChanged) {
        setError("Duplicate must have a different key, namespace, or variant than the source secret.");
        return;
      }
    }
    const ns = namespace.trim();
    if (ns && !/^[a-z][a-z0-9]*$/.test(ns)) {
      setError("Namespace must start with a letter and contain only lowercase letters and digits.");
      return;
    }
    setError(null);
    const v = variant.trim();
    const desc = description.trim();
    startTransition(async () => {
      const r = await onSubmit({
        key: key.trim(),
        value,
        ...(ns ? { namespace: ns } : {}),
        ...(v ? { variant: v } : {}),
        ...(desc ? { description: desc } : {}),
      });
      if ("error" in r) {
        setError(r.error);
        return;
      }
      onOpenChange(false);
    });
  }

  const submitting = busy || pending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {mode === "edit"
              ? "Edit secret"
              : mode === "duplicate"
              ? "Duplicate secret"
              : "New secret"}
          </DialogTitle>
          <DialogDescription>
            Keys must match <code className="font-mono">[A-Z_][A-Z0-9_]*</code>.
            Namespaces are optional and are only used internally to distinguish
            two secrets that share the same key (e.g. one{" "}
            <code className="font-mono">API_KEY</code> for Stripe and another
            for SendGrid). The namespace does NOT change the env-var name
            written to <code className="font-mono">.env.&lt;env&gt;</code> &mdash;
            that is always the bare key.
          </DialogDescription>
        </DialogHeader>
        {mode === "duplicate" && (
          <p className="text-xs text-amber-600 dark:text-amber-400">
            Change the key, namespace, or variant to create a distinct secret.
          </p>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="secret-key">Key</Label>
            <Input
              id="secret-key"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="DATABASE_URL"
              autoFocus
              required
              className="font-mono"
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="secret-namespace">
              Namespace <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="secret-namespace"
              value={namespace}
              onChange={(e) => setNamespace(e.target.value.toLowerCase())}
              placeholder="stripe"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters/digits, must start with a letter. Used only to
              disambiguate two secrets that share the same key. The env-var
              written to <code className="font-mono">.env.&lt;env&gt;</code> is
              always <code className="font-mono">&lt;KEY&gt;</code>.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="secret-variant">
              Variant <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Input
              id="secret-variant"
              value={variant}
              onChange={(e) => setVariant(e.target.value.toLowerCase())}
              placeholder="test"
              className="font-mono"
              autoComplete="off"
              spellCheck={false}
            />
            <p className="text-xs text-muted-foreground">
              Lowercase letters/digits, must start with a letter. When set, this
              secret is auto-scoped to every (repo, env) where{" "}
              <code className="font-mono">env</code> resolves to this variant
              via the vault&apos;s env&rarr;variant map. The deployed env-var name is
              still the bare <code className="font-mono">&lt;KEY&gt;</code>.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="secret-value">Value</Label>
            <div className="relative">
              <Input
                id="secret-value"
                type={reveal ? "text" : "password"}
                value={value}
                onChange={(e) => setValue(e.target.value)}
                className="pr-10 font-mono"
                placeholder="postgres://…"
              />
              <button
                type="button"
                onClick={() => setReveal((r) => !r)}
                aria-label={reveal ? "Hide value" : "Reveal value"}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                {reveal ? (
                  <EyeOff className="h-4 w-4" />
                ) : (
                  <Eye className="h-4 w-4" />
                )}
              </button>
            </div>
          </div>
          <div className="space-y-2">
            <Label htmlFor="secret-description">
              Description <span className="text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="secret-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What is this secret used for?"
              maxLength={500}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={submitting}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Saving…" : initialSecret ? "Save" : "Add"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
