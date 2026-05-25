// Tests for the daemon "set-tutorial" handler (issue #41).

import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  cleanupVaultDir,
  DEFAULT_PASSWORD,
  makeVaultDir,
  seedVault,
  startDaemon,
  type SpawnedDaemon,
} from "../_helpers/daemon-harness";
import { sendCommand } from "@/lib/cli/ipc-client";
import { loadVault } from "@/lib/vault/store";
import type { VaultData } from "@/lib/vault/schema";

const SEED: VaultData = {
  version: 3,
  repos: [],
  secrets: [
    {
      id: "s1",
      key: "DATABASE_URL",
      value: "postgres://secret-value-AAAAAA",
      scopes: [],
    },
    {
      id: "s2",
      key: "API_KEY",
      namespace: "stripe",
      value: "sk_live_AAAAAA",
      scopes: [],
    },
  ],
  envVariantMap: { global: {}, repos: {} },
};

let tmp: string;
let daemon: SpawnedDaemon | null = null;

beforeAll(async () => {
  tmp = await makeVaultDir();
  await seedVault(tmp, SEED, DEFAULT_PASSWORD);
  daemon = await startDaemon({ vaultDir: tmp });
  await daemon.ready;
});

afterAll(async () => {
  if (daemon) {
    await daemon.kill();
    daemon = null;
  }
  await cleanupVaultDir(tmp);
});

function s(cmd: string, args?: Record<string, unknown>) {
  return sendCommand(
    { cmd, args },
    { socketPathOverride: daemon!.socketPath },
  );
}

/** Read the live vault directly from disk (bypasses the daemon). */
async function readVault(): Promise<VaultData> {
  const prev = process.env.SECRETS_MANAGER_VAULT_DIR;
  process.env.SECRETS_MANAGER_VAULT_DIR = tmp;
  try {
    return await loadVault(DEFAULT_PASSWORD);
  } finally {
    if (prev === undefined) delete process.env.SECRETS_MANAGER_VAULT_DIR;
    else process.env.SECRETS_MANAGER_VAULT_DIR = prev;
  }
}

/** A valid minimal tutorial fixture. */
function validTutorial() {
  return {
    steps: [
      {
        order: 1,
        title: "Log in to the Stripe dashboard",
        body: "Navigate to https://dashboard.stripe.com and sign in.",
        link: "https://dashboard.stripe.com",
      },
      {
        order: 2,
        title: "Copy your API key",
        body: "Under Developers → API Keys, copy the secret key.",
      },
    ],
    createdAt: new Date().toISOString(),
    authorAgent: "claude-sonnet-4-5",
  };
}

describe("daemon handler: set-tutorial", () => {
  // ── happy-path ──────────────────────────────────────────────────────────

  it("attaches a valid tutorial to an existing secret", async () => {
    const r = await s("set-tutorial", {
      secret: "s1",
      tutorial: validTutorial(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    // The response must not contain the secret value.
    expect(sec).not.toHaveProperty("value");
    // The tutorial must be reflected back.
    expect(sec).toHaveProperty("tutorial");
    const tut = sec.tutorial as Record<string, unknown>;
    expect((tut.steps as unknown[]).length).toBe(2);
  });

  it("tutorial is persisted to disk", async () => {
    const tut = validTutorial();
    const r = await s("set-tutorial", { secret: "s1", tutorial: tut });
    expect(r.ok).toBe(true);

    const vault = await readVault();
    const stored = vault.secrets.find((x) => x.id === "s1");
    // The tutorial field must be on the stored secret.
    expect(stored).toHaveProperty("tutorial");
    const storedTut = (stored as Record<string, unknown>).tutorial as Record<
      string,
      unknown
    >;
    expect((storedTut.steps as unknown[]).length).toBe(2);
    expect(storedTut.authorAgent).toBe("claude-sonnet-4-5");
  });

  it("removes an existing tutorial when unset: true", async () => {
    // First, attach a tutorial.
    const attachResult = await s("set-tutorial", {
      secret: "s1",
      tutorial: validTutorial(),
    });
    expect(attachResult.ok).toBe(true);

    // Now remove it.
    const r = await s("set-tutorial", {
      secret: "s1",
      unset: true,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    // The tutorial field must be absent.
    expect(sec).not.toHaveProperty("tutorial");

    // Verify the vault on disk also omits the field.
    const vault = await readVault();
    const stored = vault.secrets.find((x) => x.id === "s1");
    expect(stored).not.toHaveProperty("tutorial");
  });

  it("value is NOT touched when tutorial is set or removed", async () => {
    await s("set-tutorial", { secret: "s1", tutorial: validTutorial() });

    const vault = await readVault();
    const stored = vault.secrets.find((x) => x.id === "s1");
    expect(stored?.value).toBe("postgres://secret-value-AAAAAA");
  });

  it("replaces an existing tutorial with a new one", async () => {
    await s("set-tutorial", { secret: "s1", tutorial: validTutorial() });

    const newTut = {
      steps: [
        {
          order: 1,
          title: "Updated step",
          body: "This is the updated tutorial body.",
        },
      ],
      createdAt: new Date().toISOString(),
    };
    const r = await s("set-tutorial", { secret: "s1", tutorial: newTut });
    expect(r.ok).toBe(true);

    const vault = await readVault();
    const stored = vault.secrets.find((x) => x.id === "s1");
    const storedTut = (stored as Record<string, unknown>).tutorial as Record<
      string,
      unknown
    >;
    expect((storedTut.steps as unknown[])[0]).toMatchObject({
      title: "Updated step",
    });
  });

  // ── error paths ─────────────────────────────────────────────────────────

  it("returns NOT_FOUND for an unknown secret id that is not a valid key", async () => {
    const r = await s("set-tutorial", {
      secret: "not-a-valid-key",
      tutorial: validTutorial(),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("NOT_FOUND");
  });

  it("auto-creates a placeholder when a valid uppercase key does not exist", async () => {
    const r = await s("set-tutorial", {
      secret: "DOES_NOT_EXIST",
      tutorial: validTutorial(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sec = r.secret as Record<string, unknown>;
    expect(sec.key).toBe("DOES_NOT_EXIST");
    expect(sec.status).toBe("awaiting_value");
    expect(r.created).toBe(true);
  });

  it("returns INVALID_INPUT when tutorial has an empty steps array", async () => {
    const badTutorial = {
      steps: [],
      createdAt: new Date().toISOString(),
    };
    const r = await s("set-tutorial", {
      secret: "s1",
      tutorial: badTutorial,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT when tutorial step body exceeds 2000 chars", async () => {
    const badTutorial = {
      steps: [
        {
          order: 1,
          title: "A title",
          body: "X".repeat(2001),
        },
      ],
      createdAt: new Date().toISOString(),
    };
    const r = await s("set-tutorial", {
      secret: "s1",
      tutorial: badTutorial,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT when tutorial is missing steps", async () => {
    const badTutorial = {
      createdAt: new Date().toISOString(),
    };
    const r = await s("set-tutorial", {
      secret: "s1",
      tutorial: badTutorial,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT when `secret` arg is missing", async () => {
    const r = await s("set-tutorial", {
      tutorial: validTutorial(),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT when neither tutorial nor unset is provided", async () => {
    const r = await s("set-tutorial", { secret: "s1" });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  it("returns INVALID_INPUT when tutorial has an invalid link URL", async () => {
    const badTutorial = {
      steps: [
        {
          order: 1,
          title: "Step 1",
          body: "Body text.",
          link: "not-a-url",
        },
      ],
      createdAt: new Date().toISOString(),
    };
    const r = await s("set-tutorial", {
      secret: "s1",
      tutorial: badTutorial,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
  });

  // ── Issue #53 — mutex + Zod field path ─────────────────────────────────────

  // D1. Daemon mutex (both unset and tutorial)
  it("returns INVALID_INPUT when both unset:true and tutorial are provided", async () => {
    // Capture the tutorial state before the rejected call (shared daemon may
    // have tutorials attached by earlier tests).
    const vaultBefore = await readVault();
    const storedBefore = vaultBefore.secrets.find((x) => x.id === "s1");
    const tutorialBefore = (storedBefore as Record<string, unknown>)?.tutorial;

    const r = await s("set-tutorial", {
      secret: "s1",
      unset: true,
      tutorial: validTutorial(),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/tutorial/);
    expect(r.message).toMatch(/unset/);
    expect(r.message).toMatch(/not both/i);

    // Side effect: s1's tutorial must be unchanged by the rejected call.
    const vaultAfter = await readVault();
    const storedAfter = vaultAfter.secrets.find((x) => x.id === "s1");
    const tutorialAfter = (storedAfter as Record<string, unknown>)?.tutorial;
    expect(tutorialAfter).toEqual(tutorialBefore);
  });

  // D2. Daemon malformed tutorial surfaces field path
  it("returns INVALID_INPUT including the field path when tutorial is malformed", async () => {
    const r = await s("set-tutorial", {
      secret: "s1",
      tutorial: {
        steps: [{ order: 1, title: "T", body: "" }],
        createdAt: new Date().toISOString(),
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/steps/);
    expect(r.message).toMatch(/body/);
    expect(r.message).toMatch(/\b0\b|\[0\]/);
  });
});

// ── Issue #53 — add-secret tutorial validation ───────────────────────────────
describe("daemon handler: add-secret tutorial validation", () => {
  let scratch: string;

  beforeEach(async () => {
    scratch = await mkdtemp(path.join(tmpdir(), "sm-daemon-addsec-"));
  });

  afterEach(async () => {
    await rm(scratch, { recursive: true, force: true });
  });

  // D3. Daemon add-secret malformed tutorial surfaces field path
  it("add-secret returns INVALID_INPUT including the field path when tutorial is malformed", async () => {
    const vp = path.join(scratch, "val.txt");
    await writeFile(vp, "some-value-AAAAAAA", "utf8");

    const r = await s("add-secret", {
      key: "NEW_KEY",
      valuePath: vp,
      tutorial: {
        steps: [{ order: 1, title: "T", body: "B", link: "not-a-url" }],
        createdAt: new Date().toISOString(),
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.code).toBe("INVALID_INPUT");
    expect(r.message).toMatch(/steps/);
    expect(r.message).toMatch(/link/);
    expect(r.message).toMatch(/\b0\b|\[0\]/);
    expect(r.message).toMatch(/invalid tutorial/i);
  });
});
