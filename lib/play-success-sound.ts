"use client";

// Short 3-note major-chord arpeggio (C5-E5-G5) used to celebrate a successful
// tutorial completion. Web Audio API — no asset dependencies. No-ops on SSR,
// on browsers without Web Audio, or when the user has prefers-reduced-motion.

let cachedCtx: AudioContext | null = null;

function getCtx(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (cachedCtx) return cachedCtx;
  const Ctor =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  try {
    cachedCtx = new Ctor();
    return cachedCtx;
  } catch {
    return null;
  }
}

function playNote(
  ctx: AudioContext,
  freq: number,
  startTime: number,
  duration: number,
): void {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "sine";
  osc.frequency.setValueAtTime(freq, startTime);
  gain.gain.setValueAtTime(0, startTime);
  gain.gain.linearRampToValueAtTime(0.18, startTime + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
  osc.connect(gain).connect(ctx.destination);
  osc.start(startTime);
  osc.stop(startTime + duration + 0.05);
}

export function playSuccessSound(): void {
  if (typeof window !== "undefined") {
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)",
    ).matches;
    if (reduced) return;
  }
  const ctx = getCtx();
  if (!ctx) return;
  if (ctx.state === "suspended") {
    void ctx.resume().catch(() => {});
  }
  const t = ctx.currentTime;
  playNote(ctx, 523.25, t, 0.18);
  playNote(ctx, 659.25, t + 0.08, 0.18);
  playNote(ctx, 783.99, t + 0.16, 0.32);
}
