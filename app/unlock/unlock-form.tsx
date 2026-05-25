"use client";

import { useEffect } from "react";
import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { toast } from "sonner";
import { Lock, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { createAction, unlockAction, clearSessionAction, type UnlockState } from "./actions";

const initialState: UnlockState = { ok: true };

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" disabled={pending} className="w-full">
      {pending ? "Working…" : label}
    </Button>
  );
}

export function UnlockForm({
  mode,
  hasStaleSession,
}: {
  mode: "unlock" | "create";
  hasStaleSession?: boolean;
}) {
  const action = mode === "create" ? createAction : unlockAction;
  const [state, formAction] = useActionState(action, initialState);

  useEffect(() => {
    if (!state.ok && state.error) {
      toast.error(state.error);
    }
  }, [state]);

  return (
    <Card className="w-full max-w-sm">
      <CardHeader className="space-y-2">
        <div className="flex items-center gap-2 text-muted-foreground">
          {mode === "create" ? (
            <KeyRound className="h-4 w-4" />
          ) : (
            <Lock className="h-4 w-4" />
          )}
          <span className="text-xs uppercase tracking-wide">
            Secrets Manager
          </span>
        </div>
        <CardTitle className="text-xl">
          {mode === "create" ? "Create master password" : "Unlock vault"}
        </CardTitle>
        <CardDescription>
          {mode === "create"
            ? "No username needed — this password encrypts your vault. Lose it and the vault is unrecoverable."
            : "Enter your master password to decrypt the vault. No username required."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {hasStaleSession && (
          <div className="mb-4 rounded border border-yellow-300 bg-yellow-50 p-3 text-sm text-yellow-800">
            <p>
              Your session is no longer active. Clear it to sign in again.
            </p>
            <form action={clearSessionAction} className="mt-2">
              <Button type="submit" variant="outline" size="sm">
                Clear session
              </Button>
            </form>
          </div>
        )}
        <form action={formAction} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="password">Master password</Label>
            <Input
              id="password"
              name="password"
              type="password"
              required
              autoFocus
              autoComplete={
                mode === "create" ? "new-password" : "current-password"
              }
              minLength={mode === "create" ? 8 : 1}
            />
          </div>
          {mode === "create" && (
            <div className="space-y-2">
              <Label htmlFor="confirm">Confirm password</Label>
              <Input
                id="confirm"
                name="confirm"
                type="password"
                required
                autoComplete="new-password"
                minLength={8}
              />
            </div>
          )}
          {!state.ok && state.error && (
            <p className="text-sm text-destructive">{state.error}</p>
          )}
          <SubmitButton
            label={mode === "create" ? "Create vault" : "Unlock"}
          />
        </form>
      </CardContent>
    </Card>
  );
}
