import { describe, expect, it } from "vitest";

import {
  getThirdColumnMode,
  shouldClearSecret,
  shouldClearRepo,
} from "@/lib/vault/view-mode";

// ---------------------------------------------------------------------------
// getThirdColumnMode — secrets view
// ---------------------------------------------------------------------------
describe("getThirdColumnMode — secrets view", () => {
  it('returns "scope" when a secret is selected (no repo selected)', () => {
    expect(getThirdColumnMode("secrets", "secret-abc", null)).toBe("scope");
  });

  it('returns "repo-secrets" when no secret is selected but a repo is selected', () => {
    expect(getThirdColumnMode("secrets", null, "repo-xyz")).toBe("repo-secrets");
  });

  it('returns "scope" when neither a secret nor a repo is selected', () => {
    expect(getThirdColumnMode("secrets", null, null)).toBe("scope");
  });

  it('returns "scope" when both a secret and a repo are selected (secret takes priority)', () => {
    expect(getThirdColumnMode("secrets", "secret-abc", "repo-xyz")).toBe("scope");
  });
});

// ---------------------------------------------------------------------------
// getThirdColumnMode — repos view
// ---------------------------------------------------------------------------
describe("getThirdColumnMode — repos view", () => {
  it('returns "repo-secrets" when a repo is selected', () => {
    expect(getThirdColumnMode("repos", null, "repo-xyz")).toBe("repo-secrets");
  });

  it('returns "repo-secrets-placeholder" when no repo is selected', () => {
    expect(getThirdColumnMode("repos", null, null)).toBe("repo-secrets-placeholder");
  });

  it('returns "repo-secrets" even when a secret is selected (repo view ignores secret selection)', () => {
    expect(getThirdColumnMode("repos", "secret-abc", "repo-xyz")).toBe("repo-secrets");
  });
});

// ---------------------------------------------------------------------------
// shouldClearSecret
// ---------------------------------------------------------------------------
describe("shouldClearSecret", () => {
  it('returns true when switching to "repos" view (secret selection should be cleared)', () => {
    expect(shouldClearSecret("repos")).toBe(true);
  });

  it('returns false when switching to "secrets" view (secret selection is kept)', () => {
    expect(shouldClearSecret("secrets")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// shouldClearRepo
// ---------------------------------------------------------------------------
describe("shouldClearRepo", () => {
  it('returns false when switching to "secrets" view (repo selection is preserved)', () => {
    expect(shouldClearRepo("secrets")).toBe(false);
  });

  it('returns false when switching to "repos" view (repo selection is kept)', () => {
    expect(shouldClearRepo("repos")).toBe(false);
  });
});
