"use client";

import { useEffect, useState } from "react";
import { BookOpen } from "lucide-react";
import type { Secret, VaultData } from "@/lib/vault/schema";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TutorialCard } from "@/components/tutorial-card";

interface ViewTutorialDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  secret: Secret | null;
  onChange: (next: VaultData) => void;
}

export function ViewTutorialDialog({
  open,
  onOpenChange,
  secret,
  onChange,
}: ViewTutorialDialogProps) {
  const [completed, setCompleted] = useState(false);

  useEffect(() => {
    setCompleted(false);
  }, [open, secret?.id]);

  return (
    <Dialog open={open && !!secret} onOpenChange={onOpenChange}>
      {secret && (
        <DialogContent className="flex max-h-[85vh] max-w-2xl flex-col gap-0 p-0">
          <DialogHeader className="flex flex-row items-center gap-2 border-b border-border pl-6 pr-12 py-4">
            <BookOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
            <DialogTitle className="text-sm">
              Tutorial &middot;{" "}
              <span className="font-mono">{secret.key}</span>
            </DialogTitle>
            <DialogDescription className="sr-only">
              Read the tutorial for this secret. You can also paste a new value
              to rotate it.
            </DialogDescription>
          </DialogHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <TutorialCard
              key={secret.id}
              secret={secret}
              onChange={onChange}
              completed={completed}
              onCompleted={() => setCompleted(true)}
            />
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
}
