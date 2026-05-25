export type SecretFlavorKind = "test" | "live" | "local" | "unknown";
export type ClassifyConfidence = "high" | "low";
export type SecretProvider =
  | "stripe"
  | "github"
  | "openai"
  | "anthropic"
  | "slack"
  | "twilio"
  | "aws"
  | "jwt"
  | "postgres"
  | "unknown";

export type SecretFlavor = {
  flavor: SecretFlavorKind;
  confidence: ClassifyConfidence;
  provider: SecretProvider;
  reason: string;
};
