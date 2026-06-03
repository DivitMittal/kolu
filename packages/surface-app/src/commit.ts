/**
 * @kolu/surface-app — resolve the build commit, once, from one source of truth.
 *
 * Node-only (uses `git`); imported by the `/vite` plugin (client define) and by
 * `buildInfoServer` (the server cell). An app never writes a sha: it's the
 * `SURFACE_APP_COMMIT` env (rename via the `envVar` arg if your build system
 * names it otherwise — e.g. kolu's `KOLU_COMMIT_HASH`), else
 * `git rev-parse --short HEAD`, else `"dev"` — which `clientIsStale` already
 * treats as never-stale, so dev builds don't false-positive as skewed.
 */

import { execSync } from "node:child_process";

/** The default env var the commit is read from. */
export const DEFAULT_COMMIT_ENV_VAR = "SURFACE_APP_COMMIT";

/** Resolve the build commit from `envVar` → `git rev-parse --short HEAD` →
 *  `"dev"`. Override `envVar` (default `SURFACE_APP_COMMIT`) when the build
 *  system uses another name. */
export function resolveCommit(envVar = DEFAULT_COMMIT_ENV_VAR): string {
  const fromEnv = process.env[envVar]?.trim();
  if (fromEnv) return fromEnv;
  try {
    const rev = execSync("git rev-parse --short HEAD", {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return rev || "dev";
  } catch {
    return "dev";
  }
}
