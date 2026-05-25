/**
 * Central import that registers every daemon handler. Importing this file
 * once at daemon-start time installs the entire surface.
 *
 * Each handler file calls `registerHandler(...)` at import time. Add new
 * files here as they land.
 */
import { registerHandler } from "../server";

import "./list-repos";
import "./list-secrets";
import "./list-scopes";
import "./describe-secret";
import "./add-repo";
import "./remove-repo";
import "./set-repo-envs";
import "./scope";
import "./scope-bulk";
import "./unscope";
import "./set-namespace";
import "./set-variant";
import "./rename-secret";
import "./add-secret";
import "./remove-secret";
import "./set-value";
import "./set-description";
import "./set-tutorial";
import "./set-idle-ttl";
import "./import";
import "./find-shared";
import "./deploy";
import "./env-variant";
import "./update-repo-path";

if (process.env.SM_DAEMON_TEST_PING === "1") {
  registerHandler("__ping__", async () => ({ ok: true }));
}
