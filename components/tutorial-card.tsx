"use client";

import { useState, useTransition, useEffect } from "react";
import { toast } from "sonner";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  PartyPopper,
} from "lucide-react";
import type { Secret, VaultData, TutorialStep } from "@/lib/vault/schema";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { renderSimpleMarkdown } from "@/lib/render-markdown";
import { setSecretValueAction } from "@/app/actions";
import { isTutorialStale } from "@/lib/vault/tutorial-staleness";
import { playSuccessSound } from "@/lib/play-success-sound";

interface TutorialCardProps {
  secret: Secret;
  onChange: (next: VaultData) => void;
  /** Render the celebration UI in place of the form. Parent-controlled so the
   * card stays celebratory after either: (a) the secret loses `awaiting_value`
   * status on first-time setup, or (b) a rotation submit completes against an
   * already-populated secret. */
  completed?: boolean;
  /** Fired once after a successful submit. */
  onCompleted?: (secretId: string) => void;
}

export function TutorialCard({
  secret,
  onChange,
  completed = false,
  onCompleted,
}: TutorialCardProps) {
  const [value, setValue] = useState("");
  const [pending, startTransition] = useTransition();
  const [checkedSteps, setCheckedSteps] = useState<Set<number>>(new Set());
  // Snapshot of `isAwaiting` taken at the moment of submit. The server strips
  // `status` once a value is provided, so by the time `completed=true` propagates
  // back the live secret.status is undefined — we need the pre-submit value to
  // pick the correct celebration copy ("Saved!" vs "Updated!").
  const [submittedAsAwaiting, setSubmittedAsAwaiting] = useState<boolean | null>(
    null,
  );

  useEffect(() => {
    if (!secret.tutorial) return;
    const done = new Set<number>();
    for (const step of secret.tutorial.steps) {
      const key = `sm:tutorial:${secret.id}:step:${step.order}:done`;
      if (localStorage.getItem(key) === "true") {
        done.add(step.order);
      }
    }
    setCheckedSteps(done);
  }, [secret.id, secret.tutorial]);

  function handleStepCheck(step: TutorialStep, checked: boolean) {
    const key = `sm:tutorial:${secret.id}:step:${step.order}:done`;
    if (checked) {
      localStorage.setItem(key, "true");
    } else {
      localStorage.removeItem(key);
    }
    setCheckedSteps((prev) => {
      const next = new Set(prev);
      if (checked) next.add(step.order);
      else next.delete(step.order);
      return next;
    });
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = value.trim();
    if (!trimmed) return;
    const wasAwaiting = secret.status === "awaiting_value";
    startTransition(async () => {
      const result = await setSecretValueAction(secret.id, trimmed);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (secret.tutorial) {
        for (const step of secret.tutorial.steps) {
          localStorage.removeItem(
            `sm:tutorial:${secret.id}:step:${step.order}:done`,
          );
        }
      }
      playSuccessSound();
      toast.success(`Value set for ${secret.key}.`);
      setSubmittedAsAwaiting(wasAwaiting);
      onChange(result.data);
      onCompleted?.(secret.id);
    });
  }

  const isAwaiting = secret.status === "awaiting_value";
  // For the celebration branch, prefer the pre-submit snapshot. Falls back to
  // the live status when `completed` is forced by a parent without a submit
  // having happened through this card.
  const celebrationIsAwaiting = submittedAsAwaiting ?? isAwaiting;

  if (completed) {
    return (
      <Card className="border-green-300 bg-green-50/60 dark:border-green-900/50 dark:bg-green-950/20">
        <CardContent className="flex flex-col items-center gap-3 px-6 py-10 text-center">
          <div className="rounded-full bg-green-100 p-3 dark:bg-green-900/40">
            <CheckCircle2 className="h-8 w-8 text-green-600 dark:text-green-400" />
          </div>
          <div className="space-y-1">
            <div className="flex items-center justify-center gap-2 text-base font-semibold text-green-900 dark:text-green-200">
              <PartyPopper className="h-4 w-4" />
              {celebrationIsAwaiting ? "Saved!" : "Updated!"}
            </div>
            <p className="font-mono text-xs text-green-800/80 dark:text-green-300/80">
              {secret.key}{" "}
              {celebrationIsAwaiting
                ? "is ready to deploy."
                : "has been updated."}
            </p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const stale = secret.tutorial ? isTutorialStale(secret.tutorial) : false;

  return (
    <Card className="border-amber-200 dark:border-amber-900/50">
      <CardHeader className="flex flex-row items-start justify-between gap-2 px-4 py-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <span className="truncate font-mono text-sm font-semibold">
              {secret.key}
            </span>
            {secret.namespace && (
              <span className="rounded bg-secondary px-1.5 py-0.5 font-mono text-[10px] font-medium text-muted-foreground">
                {secret.namespace}
              </span>
            )}
          </div>
          {secret.tutorial && (
            <div className="text-[10px] text-muted-foreground">
              Tutorial by {secret.tutorial.authorAgent ?? "agent"} &middot;{" "}
              {new Date(secret.tutorial.createdAt).toLocaleDateString()}
            </div>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4 px-4 pb-4">
        {stale && (
          <div
            role="alert"
            className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-100 px-3 py-2 text-xs text-amber-800 dark:border-amber-700 dark:bg-amber-900/30 dark:text-amber-300"
          >
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span>
              These instructions may be outdated. Verify steps before proceeding.
            </span>
          </div>
        )}

        {secret.tutorial && (
          <ol className="space-y-3">
            {[...secret.tutorial.steps]
              .sort((a, b) => a.order - b.order)
              .map((step) => {
                const isDone = checkedSteps.has(step.order);
                return (
                  <li
                    key={step.order}
                    className={cn(
                      "space-y-2 rounded-md border p-3 transition-colors",
                      isDone
                        ? "border-green-200 bg-green-50/60 dark:border-green-900/40 dark:bg-green-950/20"
                        : "border-border bg-background",
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <Checkbox
                        id={`step-${secret.id}-${step.order}`}
                        checked={isDone}
                        onCheckedChange={(v) => handleStepCheck(step, v === true)}
                        aria-label={`Mark step "${step.title}" as done`}
                        className="mt-0.5 shrink-0"
                      />
                      <Label
                        htmlFor={`step-${secret.id}-${step.order}`}
                        className={cn(
                          "cursor-pointer text-sm font-medium leading-snug",
                          isDone && "text-muted-foreground line-through",
                        )}
                      >
                        {step.title}
                      </Label>
                      {isDone && (
                        <CheckCircle2 className="ml-auto h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
                      )}
                    </div>

                    <div
                      className="prose-sm pl-6 text-sm text-muted-foreground"
                      dangerouslySetInnerHTML={{
                        __html: renderSimpleMarkdown(step.body),
                      }}
                    />

                    {step.link && /^https?:\/\//i.test(step.link) && (
                      <div className="pl-6">
                        <Button
                          asChild
                          variant="outline"
                          size="sm"
                          className="h-7 gap-1.5 text-xs"
                        >
                          <a
                            href={step.link}
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            <ExternalLink className="h-3 w-3" />
                            Open link
                          </a>
                        </Button>
                      </div>
                    )}
                  </li>
                );
              })}
          </ol>
        )}

        {!secret.tutorial && (
          <p className="text-xs text-muted-foreground">
            {isAwaiting
              ? "No tutorial provided. Enter the secret value below."
              : "No tutorial provided. Paste a new value below to rotate."}
          </p>
        )}

        <form onSubmit={handleSubmit} className="space-y-2">
          <Label htmlFor={`value-${secret.id}`} className="text-xs font-medium">
            {isAwaiting ? "Enter value for" : "Update value for"}{" "}
            <code className="font-mono">{secret.key}</code>
          </Label>
          <div className="flex gap-2">
            <Input
              id={`value-${secret.id}`}
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={
                isAwaiting
                  ? "Paste or type the secret value…"
                  : "Paste a new value to rotate (or leave blank to just read)…"
              }
              className="flex-1 font-mono text-sm"
              autoComplete="off"
              disabled={pending}
            />
            <Button
              type="submit"
              size="sm"
              disabled={pending || value.trim() === ""}
            >
              <CheckCircle2 className="h-4 w-4" />
              {pending
                ? isAwaiting
                  ? "Saving…"
                  : "Updating…"
                : isAwaiting
                  ? "Complete"
                  : "Update"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
