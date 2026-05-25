/**
 * Central import for every CLI subcommand. Importing this file populates
 * the router registry. Order doesn't matter; each command file calls
 * `register(...)` at import time.
 */
import "./list-repos";
import "./list-secrets";
import "./list-scopes";
import "./describe-secret";
import "./add-repo";
import "./remove-repo";
import "./set-repo-envs";
import "./scope";
import "./unscope";
import "./set-namespace";
import "./set-variant";
import "./env-variant";
import "./rename-secret";
import "./add-secret";
import "./remove-secret";
import "./set-value";
import "./set-description";
import "./import";
import "./find-shared";
import "./deploy";
import "./update-repo-path";
