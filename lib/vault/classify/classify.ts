import type { SecretFlavor } from "./types";

function classifyPostgresUrl(value: string): SecretFlavor | null {
  try {
    const url = new URL(value);
    if (!url.protocol.startsWith("postgres")) return null;
    // url.hostname may return "[::1]" (with brackets) for non-http schemes
    const rawHost = url.hostname.toLowerCase();
    const host = rawHost.startsWith("[") && rawHost.endsWith("]")
      ? rawHost.slice(1, -1)
      : rawHost;
    if (["localhost", "127.0.0.1", "::1"].includes(host)) {
      return { flavor: "local", confidence: "high", provider: "postgres", reason: "postgres-url:local-host" };
    }
    const segments = host.split(/[.\-]/);
    if (segments.includes("staging") || segments.includes("dev")) {
      return { flavor: "test", confidence: "high", provider: "postgres", reason: "postgres-url:staging-host" };
    }
    return null;
  } catch { return null; }
}

export function classifySecret(value: string): SecretFlavor {
  if (value.startsWith("sk_test_")) {
    return { flavor: "test", confidence: "high", provider: "stripe", reason: "prefix:sk_test_" };
  }

  if (value.startsWith("sk_live_")) {
    return { flavor: "live", confidence: "high", provider: "stripe", reason: "prefix:sk_live_" };
  }

  if (value.startsWith("ghp_") || value.startsWith("gho_") || value.startsWith("ghs_")) {
    return { flavor: "live", confidence: "high", provider: "github", reason: "prefix:gh[pos]_" };
  }

  if (value.startsWith("sk-ant-")) {
    return { flavor: "live", confidence: "high", provider: "anthropic", reason: "prefix:sk-ant-" };
  }

  if (value.startsWith("sk-")) {
    return { flavor: "live", confidence: "high", provider: "openai", reason: "prefix:sk-" };
  }

  if (value.startsWith("xoxb-") || value.startsWith("xoxp-")) {
    return { flavor: "live", confidence: "high", provider: "slack", reason: "prefix:xox[bp]-" };
  }

  if (/^SK[0-9a-fA-F]{32}$/.test(value)) {
    return { flavor: "live", confidence: "high", provider: "twilio", reason: "pattern:SK+32hex" };
  }

  if (value.startsWith("AKIA")) {
    return { flavor: "live", confidence: "high", provider: "aws", reason: "prefix:AKIA" };
  }

  const pgFlavor = classifyPostgresUrl(value);
  if (pgFlavor) return pgFlavor;

  if (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value)) {
    return { flavor: "unknown", confidence: "high", provider: "jwt", reason: "pattern:jwt-shape" };
  }

  // Low-confidence keyword fallback
  const lower = value.toLowerCase();
  if (lower.includes("test")) {
    return { flavor: "test", confidence: "low", provider: "unknown", reason: "substring:test" };
  }
  if (lower.includes("staging")) {
    return { flavor: "test", confidence: "low", provider: "unknown", reason: "substring:staging" };
  }
  if (lower.includes("live")) {
    return { flavor: "live", confidence: "low", provider: "unknown", reason: "substring:live" };
  }
  if (lower.includes("prod")) {
    return { flavor: "live", confidence: "low", provider: "unknown", reason: "substring:prod" };
  }

  // Default
  return { flavor: "unknown", confidence: "low", provider: "unknown", reason: "no-match" };
}
