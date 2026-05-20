/**
 * Shared git IO helpers — `gitOutput` and `realpath`.
 *
 * `gitOutput` runs git through an {@link Executor} and returns stdout.
 * Throws on non-zero exit by default. `allowExitOne: true` is the
 * `git diff --no-index` convention (exit 1 with non-empty stdout means
 * "files differ" — a successful signal, not an error).
 *
 * `realpath` canonicalises a path via `readlink -f` on the executor —
 * equivalent to `fs.realpathSync` on local, works on remote without
 * touching the controller's filesystem.
 */

import type { Executor } from "kolu-io";

/** Canonicalize a path via the executor's `readlink -f`. Falls back to
 *  the original path on failure (e.g. `readlink` missing on Windows). */
export async function realpath(executor: Executor, p: string): Promise<string> {
  const result = await executor.exec("readlink", ["-f", p]);
  return result.exitCode === 0 ? result.stdout.trim() : p;
}

export async function gitOutput(
  executor: Executor,
  cwd: string,
  args: string[],
  opts?: { allowExitOne?: boolean; maxBytes?: number },
): Promise<string> {
  const result = await executor.exec("git", args, {
    cwd,
    maxBytes: opts?.maxBytes ?? 128 * 1024 * 1024,
  });
  if (result.exitCode === 0) return result.stdout;
  if (opts?.allowExitOne && result.exitCode === 1 && result.stdout.length > 0) {
    return result.stdout;
  }
  throw new Error(result.stderr.trim() || `git exited ${result.exitCode}`);
}
