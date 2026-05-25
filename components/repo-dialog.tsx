"use client";

import { useEffect, useState, useTransition } from "react";
import { X } from "lucide-react";
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
import { cn } from "@/lib/utils";
import type { Repo } from "@/lib/vault/schema";

type FormShape = { name: string; path: string; environments: string[] };
type SubmitResult = { ok: true } | { error: string };

export function RepoDialog({
  open,
  onOpenChange,
  initialRepo,
  onSubmit,
  busy,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  initialRepo: Repo | null;
  onSubmit: (form: FormShape) => Promise<SubmitResult>;
  busy?: boolean;
}) {
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [envs, setEnvs] = useState<string[]>([]);
  const [envInput, setEnvInput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (open) {
      setName(initialRepo?.name ?? "");
      setPath(initialRepo?.path ?? "");
      setEnvs(initialRepo?.environments ?? ["development", "production"]);
      setEnvInput("");
      setError(null);
    }
  }, [open, initialRepo]);

  function commitEnvInput() {
    const cleaned = envInput.trim();
    if (cleaned.length === 0) return;
    if (envs.includes(cleaned)) {
      setEnvInput("");
      return;
    }
    setEnvs((prev) => [...prev, cleaned]);
    setEnvInput("");
  }

  function removeEnv(env: string) {
    setEnvs((prev) => prev.filter((e) => e !== env));
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !path.trim() || envs.length === 0) {
      setError("Fill in name, path, and at least one environment.");
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await onSubmit({ name: name.trim(), path: path.trim(), environments: envs });
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
            {initialRepo ? "Edit repo" : "Register repo"}
          </DialogTitle>
          <DialogDescription>
            A repo is a project directory and the list of environments it ships.
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="repo-name">Name</Label>
            <Input
              id="repo-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="my-app"
              autoFocus
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="repo-path">Absolute path</Label>
            <Input
              id="repo-path"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              placeholder="/Users/you/Developer/my-app"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="repo-envs">Environments</Label>
            <div
              className={cn(
                "flex flex-wrap items-center gap-1 rounded-md border border-input bg-transparent px-2 py-1 focus-within:ring-1 focus-within:ring-ring",
              )}
            >
              {envs.map((env) => (
                <span
                  key={env}
                  className="flex items-center gap-1 rounded bg-secondary px-2 py-0.5 text-xs"
                >
                  {env}
                  <button
                    type="button"
                    onClick={() => removeEnv(env)}
                    aria-label={`Remove ${env}`}
                    className="text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </span>
              ))}
              <input
                id="repo-envs"
                value={envInput}
                onChange={(e) => setEnvInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === ",") {
                    e.preventDefault();
                    commitEnvInput();
                  } else if (e.key === "Backspace" && envInput === "" && envs.length > 0) {
                    setEnvs((prev) => prev.slice(0, -1));
                  }
                }}
                onBlur={commitEnvInput}
                className="min-w-[6rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-muted-foreground"
                placeholder={envs.length === 0 ? "development, production…" : ""}
              />
            </div>
            <p className="text-xs text-muted-foreground">
              Press Enter or comma to add. Backspace at the start removes the last chip.
            </p>
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
              {submitting ? "Saving…" : initialRepo ? "Save" : "Register"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
