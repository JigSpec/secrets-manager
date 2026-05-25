export type ViewMode = "secrets" | "repos";
export type ThirdColumnMode = "scope" | "repo-secrets" | "repo-secrets-placeholder";

// Returns which content mode the third column should render
export function getThirdColumnMode(
  view: ViewMode,
  selectedSecretId: string | null,
  selectedRepoId: string | null
): ThirdColumnMode {
  if (view === "repos") {
    return selectedRepoId !== null ? "repo-secrets" : "repo-secrets-placeholder";
  }
  // view === "secrets"
  return selectedSecretId !== null || selectedRepoId === null ? "scope" : "repo-secrets";
}

// Returns whether switching to a new view should clear the secret selection
export function shouldClearSecret(newView: ViewMode): boolean {
  return newView === "repos";
}

// Repo selection is preserved across view switches; getThirdColumnMode handles the display logic.
export function shouldClearRepo(_newView: ViewMode): boolean {
  return false;
}
