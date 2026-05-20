/**
 * `gitOutput` — run git through an {@link Executor} and return stdout.
 * Throws on non-zero exit by default. `allowExitOne: true` is the
 * `git diff --no-index` convention (exit 1 with non-empty stdout means
 * "files differ" — a successful signal, not an error); only `review.ts`
 * needs that variant, but exposing the option here lets all kolu-git
 * IO go through one helper.
 */

import type { Executor } from "kolu-io";

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
