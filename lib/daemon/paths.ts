import path from "node:path";

import { vaultDir } from "../vault/store";

export function socketPath(): string {
  return path.join(vaultDir(), "sm.sock");
}

export function pidPath(): string {
  return path.join(vaultDir(), "sm.pid");
}
