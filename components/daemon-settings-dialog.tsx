"use client";

import { useEffect, useState, useTransition } from "react";
import { toast } from "sonner";
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
import {
  getDaemonTtlInfoAction,
  setDaemonIdleTtlAction,
  type DaemonTtlInfo,
} from "@/app/actions";

const PRESETS_MIN = [15, 60, 240, 480, 1440] as const;

function formatMinutes(min: number | null): string {
  if (min === null) return "—";
  if (min < 60) return `${min} min`;
  if (min === 60) return "1 hour";
  if (min < 1440) {
    const h = min / 60;
    return Number.isInteger(h) ? `${h} hours` : `${h.toFixed(1)} hours`;
  }
  const d = min / 1440;
  return Number.isInteger(d) ? `${d} day${d === 1 ? "" : "s"}` : `${d.toFixed(1)} days`;
}

export function DaemonSettingsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const [info, setInfo] = useState<DaemonTtlInfo | null>(null);
  const [minutes, setMinutes] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError(null);
    void getDaemonTtlInfoAction()
      .then((data) => {
        setInfo(data);
        const initial =
          data.liveMinutes ?? data.savedMinutes ?? data.defaultMinutes;
        setMinutes(String(initial));
      })
      .finally(() => {
        setLoading(false);
      });
  }, [open]);

  function handlePreset(value: number) {
    setMinutes(String(value));
    setError(null);
  }

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!info) return;
    const n = Number(minutes);
    if (!Number.isFinite(n) || n < info.minMinutes || n > info.maxMinutes) {
      setError(
        `Enter a number between ${info.minMinutes} and ${info.maxMinutes}.`,
      );
      return;
    }
    setError(null);
    startTransition(async () => {
      const r = await setDaemonIdleTtlAction(n);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      if (r.applied === "live") {
        toast.success(
          `Daemon auto-lock set to ${formatMinutes(r.minutes)} of inactivity.`,
        );
      } else {
        toast.success(
          `Saved — daemon will use ${formatMinutes(r.minutes)} the next time it starts.`,
        );
      }
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Daemon settings</DialogTitle>
          <DialogDescription>
            How long the background daemon stays unlocked when nothing is
            happening. The CLI and the MCP server lose access once the daemon
            locks itself.
          </DialogDescription>
        </DialogHeader>

        {loading || !info ? (
          <div className="py-6 text-center text-sm text-muted-foreground">
            Loading…
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="rounded-md border border-border bg-muted/30 p-3 text-xs text-muted-foreground space-y-1">
              <div>
                <span className="font-medium text-foreground">Current:</span>{" "}
                {info.daemonRunning
                  ? `${formatMinutes(info.liveMinutes)} (live)`
                  : "daemon is locked"}
              </div>
              <div>
                <span className="font-medium text-foreground">Saved:</span>{" "}
                {info.savedMinutes === null
                  ? `none — using default of ${formatMinutes(info.defaultMinutes)}`
                  : formatMinutes(info.savedMinutes)}
              </div>
            </div>

            <div className="space-y-2">
              <Label htmlFor="daemon-ttl-minutes">
                Auto-lock after inactivity (minutes)
              </Label>
              <Input
                id="daemon-ttl-minutes"
                type="number"
                min={info.minMinutes}
                max={info.maxMinutes}
                step={1}
                value={minutes}
                onChange={(e) => setMinutes(e.target.value)}
                autoFocus
                required
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {PRESETS_MIN.map((p) => (
                  <Button
                    key={p}
                    type="button"
                    size="sm"
                    variant={minutes === String(p) ? "default" : "outline"}
                    onClick={() => handlePreset(p)}
                  >
                    {formatMinutes(p)}
                  </Button>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Range: {info.minMinutes}–{info.maxMinutes} minutes. The new
                value takes effect immediately if the daemon is running, and is
                persisted across restarts.
              </p>
            </div>

            {error && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive">
                {error}
              </div>
            )}

            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={pending}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
