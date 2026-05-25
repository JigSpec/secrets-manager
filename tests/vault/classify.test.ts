import { describe, expect, it } from "vitest";

import { classifySecret } from "@/lib/vault/classify";

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------
describe("Stripe secrets", () => {
  it("classifies sk_test_ prefix as test/high/stripe", () => {
    const result = classifySecret("sk_test_abc123");
    expect(result.flavor).toBe("test");
    expect(result.confidence).toBe("high");
    expect(result.provider).toBe("stripe");
    expect(result.reason).toBe("prefix:sk_test_");
  });

  it("classifies sk_live_ prefix as live/high/stripe", () => {
    const result = classifySecret("sk_live_xyz789");
    expect(result.flavor).toBe("live");
    expect(result.confidence).toBe("high");
    expect(result.provider).toBe("stripe");
  });
});

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------
describe("GitHub secrets", () => {
  it("classifies ghp_ prefix as live/github", () => {
    const result = classifySecret("ghp_sometoken");
    expect(result.flavor).toBe("live");
    expect(result.provider).toBe("github");
  });

  it("classifies gho_ prefix as live/github", () => {
    const result = classifySecret("gho_sometoken");
    expect(result.flavor).toBe("live");
    expect(result.provider).toBe("github");
  });

  it("classifies ghs_ prefix as live/github", () => {
    const result = classifySecret("ghs_sometoken");
    expect(result.flavor).toBe("live");
    expect(result.provider).toBe("github");
  });
});

// ---------------------------------------------------------------------------
// OpenAI vs Anthropic — ordering matters
// ---------------------------------------------------------------------------
describe("OpenAI vs Anthropic ordering", () => {
  it("classifies sk-proj- prefix as live/openai (not anthropic)", () => {
    const result = classifySecret("sk-proj-abc123longkeyhere");
    expect(result.flavor).toBe("live");
    expect(result.provider).toBe("openai");
  });

  it("classifies sk-ant-api03- prefix as live/anthropic (not openai)", () => {
    const result = classifySecret("sk-ant-api03-xxxxxx");
    expect(result.flavor).toBe("live");
    expect(result.provider).toBe("anthropic");
  });
});

// ---------------------------------------------------------------------------
// Slack
// ---------------------------------------------------------------------------
describe("Slack secrets", () => {
  it("classifies xoxb- prefix as live/slack", () => {
    const result = classifySecret("xoxb-123-456-789");
    expect(result.flavor).toBe("live");
    expect(result.provider).toBe("slack");
  });

  it("classifies xoxp- prefix as live/slack", () => {
    const result = classifySecret("xoxp-123-456-789");
    expect(result.flavor).toBe("live");
    expect(result.provider).toBe("slack");
  });
});

// ---------------------------------------------------------------------------
// Twilio
// ---------------------------------------------------------------------------
describe("Twilio secrets", () => {
  it("classifies SK + 32 lowercase hex chars as twilio", () => {
    const value = "SK" + "a".repeat(32);
    const result = classifySecret(value);
    expect(result.provider).toBe("twilio");
  });

  it("classifies SK + 32 uppercase hex chars as twilio (case-insensitive)", () => {
    const value = "SK" + "A".repeat(32);
    const result = classifySecret(value);
    expect(result.provider).toBe("twilio");
  });

  it("does NOT classify SK + 32 non-hex chars as twilio", () => {
    const value = "SK" + "g".repeat(32);
    const result = classifySecret(value);
    expect(result.provider).not.toBe("twilio");
  });
});

// ---------------------------------------------------------------------------
// AWS
// ---------------------------------------------------------------------------
describe("AWS secrets", () => {
  it("classifies AKIA... as live/aws", () => {
    const result = classifySecret("AKIAIOSFODNN7EXAMPLE");
    expect(result.flavor).toBe("live");
    expect(result.provider).toBe("aws");
  });
});

// ---------------------------------------------------------------------------
// Postgres — local
// ---------------------------------------------------------------------------
describe("Postgres local URIs", () => {
  it("classifies postgres://...localhost/... as local/postgres", () => {
    const result = classifySecret("postgres://user:pass@localhost/mydb");
    expect(result.flavor).toBe("local");
    expect(result.provider).toBe("postgres");
  });

  it("classifies postgresql://...127.0.0.1.../... as local/postgres", () => {
    const result = classifySecret(
      "postgresql://user:pass@127.0.0.1:5432/mydb",
    );
    expect(result.flavor).toBe("local");
    expect(result.provider).toBe("postgres");
  });

  it("classifies postgresql://...::1.../... as local/postgres", () => {
    const result = classifySecret("postgresql://user:pass@[::1]:5432/mydb");
    expect(result.flavor).toBe("local");
    expect(result.provider).toBe("postgres");
  });
});

// ---------------------------------------------------------------------------
// Postgres — staging / dev
// ---------------------------------------------------------------------------
describe("Postgres staging/dev URIs", () => {
  it("classifies postgres://...staging.../... as test/postgres", () => {
    const result = classifySecret(
      "postgres://user:pass@staging.example.com/mydb",
    );
    expect(result.flavor).toBe("test");
    expect(result.provider).toBe("postgres");
  });

  it("classifies postgres://...dev-db.internal/... as test/postgres", () => {
    const result = classifySecret("postgres://user:pass@dev-db.internal/mydb");
    expect(result.flavor).toBe("test");
    expect(result.provider).toBe("postgres");
  });
});

// ---------------------------------------------------------------------------
// JWT shape
// ---------------------------------------------------------------------------
describe("JWT", () => {
  it("classifies three-part base64url token as unknown/jwt", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c";
    const result = classifySecret(jwt);
    expect(result.flavor).toBe("unknown");
    expect(result.provider).toBe("jwt");
  });
});

// ---------------------------------------------------------------------------
// Low-confidence fallback (keyword heuristic)
// ---------------------------------------------------------------------------
describe("low-confidence keyword fallback", () => {
  it("classifies my_test_api_key as test/low/unknown", () => {
    const result = classifySecret("my_test_api_key");
    expect(result.flavor).toBe("test");
    expect(result.confidence).toBe("low");
    expect(result.provider).toBe("unknown");
  });

  it("classifies production_database_password as live/low/unknown", () => {
    const result = classifySecret("production_database_password");
    expect(result.flavor).toBe("live");
    expect(result.confidence).toBe("low");
    expect(result.provider).toBe("unknown");
  });

  it("classifies staging_key_123 as test/low/unknown", () => {
    const result = classifySecret("staging_key_123");
    expect(result.flavor).toBe("test");
    expect(result.confidence).toBe("low");
    expect(result.provider).toBe("unknown");
  });

  it("classifies LIVE_SECRET_KEY as live/low/unknown", () => {
    const result = classifySecret("LIVE_SECRET_KEY");
    expect(result.flavor).toBe("live");
    expect(result.confidence).toBe("low");
    expect(result.provider).toBe("unknown");
  });
});

// ---------------------------------------------------------------------------
// Unknown / no match
// ---------------------------------------------------------------------------
describe("unknown / no-match", () => {
  it("classifies abc123 as unknown/low/unknown with reason no-match", () => {
    const result = classifySecret("abc123");
    expect(result.flavor).toBe("unknown");
    expect(result.confidence).toBe("low");
    expect(result.provider).toBe("unknown");
    expect(result.reason).toBe("no-match");
  });

  it("classifies totally-random-value as unknown/low", () => {
    const result = classifySecret("totally-random-value");
    expect(result.flavor).toBe("unknown");
    expect(result.confidence).toBe("low");
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------
describe("edge cases", () => {
  it("classifies empty string as unknown/low/unknown", () => {
    const result = classifySecret("");
    expect(result.flavor).toBe("unknown");
    expect(result.confidence).toBe("low");
    expect(result.provider).toBe("unknown");
  });

  it("does NOT classify postgres://developers.example.com/db as test (dev is a substring, not a segment)", () => {
    const result = classifySecret("postgres://developers.example.com/db");
    expect(result.flavor).not.toBe("test");
  });
});

// ---------------------------------------------------------------------------
// Security: reason must never contain a value excerpt
// ---------------------------------------------------------------------------
describe("security: reason is never a value excerpt", () => {
  it("reason for sk_test_ is exactly the static string 'prefix:sk_test_'", () => {
    const result = classifySecret("sk_test_mysupersecretkey");
    expect(result.reason).toBe("prefix:sk_test_");
  });

  const testCases: Array<{ label: string; value: string }> = [
    { label: "stripe test", value: "sk_test_abc123longvalue" },
    { label: "stripe live", value: "sk_live_abc123longvalue" },
    { label: "github ghp", value: "ghp_somereallylongtoken" },
    { label: "openai", value: "sk-proj-abc123longkeyhere" },
    { label: "anthropic", value: "sk-ant-api03-xxxxxx" },
    { label: "slack xoxb", value: "xoxb-123-456-789" },
    { label: "aws", value: "AKIAIOSFODNN7EXAMPLE" },
    { label: "postgres local", value: "postgres://user:pass@localhost/mydb" },
    { label: "jwt", value: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c" },
    { label: "low-confidence test", value: "my_test_api_key" },
    { label: "no-match", value: "abc123" },
  ];

  for (const { label, value } of testCases) {
    it(`reason for "${label}" does not contain any substring of the input longer than 10 chars`, () => {
      const result = classifySecret(value);
      const reason = result.reason ?? "";
      // Slide a 11-char window over the input and assert none appear in reason
      for (let i = 0; i <= value.length - 11; i++) {
        const excerpt = value.slice(i, i + 11);
        expect(
          reason.includes(excerpt),
          `reason "${reason}" contains input excerpt "${excerpt}" (position ${i})`,
        ).toBe(false);
      }
    });
  }
});
