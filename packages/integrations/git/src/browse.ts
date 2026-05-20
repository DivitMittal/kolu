/** File tree browsing — git-filtered file listing and file reading.
 *
 *  Uses `git ls-files --cached --others --exclude-standard` to enumerate
 *  tracked + untracked-but-not-ignored paths in one shot. This avoids
 *  listing `node_modules/`, `.git/`, build artifacts, etc.
 *
 *  All IO is routed through an {@link Executor} so the same code works
 *  for local repos (default `localExecutor`) and remote repos behind an
 *  SSH helper (caller-supplied `Host`). */

import { type Executor, localExecutor } from "kolu-io";
import type { Logger } from "kolu-shared";
import { err, type GitResult, ok } from "./errors.ts";
import { resolveUnder } from "./safe-path.ts";

/** Max file size to read (1 MB). Larger files get a truncation notice. */
const MAX_READ_BYTES = 1_048_576;

/** Flat list of every repo-relative path (tracked + untracked-but-not-ignored).
 *  One-shot snapshot for Pierre's `@pierre/trees`, which builds the tree
 *  hierarchy itself from a flat path list. */
export async function listAll(
  repoPath: string,
  log?: Logger,
  executor: Executor = localExecutor,
): Promise<GitResult<string[]>> {
  try {
    const { stdout, exitCode, stderr } = await executor.exec(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard"],
      { cwd: repoPath, maxBytes: 64 * 1024 * 1024 },
    );
    if (exitCode !== 0) {
      log?.error({ stderr, repoPath }, "git ls-files non-zero exit");
      return err({
        code: "GIT_FAILED",
        message: `git ls-files exited ${exitCode}: ${stderr}`,
      });
    }
    const paths = stdout.split("\n").filter((l) => l.length > 0);
    return ok(paths);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    log?.error({ err: e, repoPath }, "git ls-files failed");
    return err({ code: "GIT_FAILED", message: `Failed to list files: ${msg}` });
  }
}

/** Read a file's UTF-8 content, guarded against path traversal. */
export async function readFile(
  repoPath: string,
  filePath: string,
  log?: Logger,
  executor: Executor = localExecutor,
): Promise<GitResult<{ content: string; truncated: boolean }>> {
  const resolved = resolveUnder(repoPath, filePath, log);
  if (!resolved.ok)
    return resolved as GitResult<{ content: string; truncated: boolean }>;

  try {
    return ok(
      await executor.readFile(resolved.value.abs, { maxBytes: MAX_READ_BYTES }),
    );
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err({ code: "GIT_FAILED", message: `Failed to read file: ${msg}` });
  }
}

/** Stat a file's mtime in ms-since-epoch, used to cache-bust the iframe URL
 *  for binary previewable kinds. Same path-traversal guard as `readFile`. */
export async function statFileMtimeMs(
  repoPath: string,
  filePath: string,
  log?: Logger,
  executor: Executor = localExecutor,
): Promise<GitResult<number>> {
  const resolved = resolveUnder(repoPath, filePath, log);
  if (!resolved.ok) return resolved as GitResult<number>;
  try {
    const mtimeMs = await executor.statMtimeMs(resolved.value.abs);
    return ok(mtimeMs);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return err({ code: "GIT_FAILED", message: `Failed to stat file: ${msg}` });
  }
}
