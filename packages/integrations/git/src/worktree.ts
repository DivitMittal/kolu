/**
 * Git worktree operations — create and remove worktrees.
 * Worktrees are stored in `.worktrees/<name>` relative to the main repo root.
 *
 * All IO is routed through {@link Executor} so the same code works
 * against the controller's local fs (`localExecutor`, the default) or a
 * remote host via the SSH helper.
 */

import path from "node:path";
import { type Executor, localExecutor } from "kolu-io";
import type { Logger } from "kolu-shared";
import { err, type GitResult, ok } from "./errors.ts";
import { gitOutput } from "./git-exec.ts";

/** Existence probe via {@link Executor.statMtimeMs} — rejects when the
 *  path does not exist, so a failed call means "absent". */
async function pathExists(
  executor: Executor,
  filePath: string,
): Promise<boolean> {
  try {
    await executor.statMtimeMs(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Resolve the main repo root from any path inside a repo (including
 *  worktrees). Uses `git rev-parse --git-common-dir` + `readlink -f` so
 *  the answer matches `fs.realpathSync` on local and works on remote. */
async function resolveMainRepoRoot(
  executor: Executor,
  repoPath: string,
): Promise<string> {
  const gitCommonDir = (
    await gitOutput(executor, repoPath, ["rev-parse", "--git-common-dir"])
  ).trim();
  const resolved = path.resolve(repoPath, gitCommonDir);
  const { stdout, exitCode } = await executor.exec("readlink", [
    "-f",
    resolved,
  ]);
  const canonical = exitCode === 0 ? stdout.trim() : resolved;
  return path.dirname(canonical);
}

/** Detect the default branch name on the remote (e.g. "main" or "master"). */
export async function detectDefaultBranch(
  repoPath: string,
  executor: Executor = localExecutor,
): Promise<string> {
  const head = await executor.exec(
    "git",
    ["symbolic-ref", "refs/remotes/origin/HEAD"],
    { cwd: repoPath },
  );
  if (head.exitCode === 0) {
    return head.stdout.trim().replace("refs/remotes/origin/", "");
  }
  const main = await executor.exec(
    "git",
    ["rev-parse", "--verify", "origin/main"],
    { cwd: repoPath },
  );
  if (main.exitCode === 0) return "main";
  return "master";
}

/**
 * Create a git worktree at `.worktrees/<name>` on a new branch `<name>`,
 * based on `origin/<default>`. Fails fast on collision; callers choose
 * how to recover.
 */
export async function worktreeCreate(
  repoPath: string,
  name: string,
  log?: Logger,
  executor: Executor = localExecutor,
): Promise<GitResult<{ path: string; branch: string }>> {
  try {
    const mainRoot = await resolveMainRepoRoot(executor, repoPath);

    log?.info({ mainRoot }, "fetching origin");
    await gitOutput(executor, mainRoot, ["fetch", "origin"]);
    // Best-effort: update origin/HEAD to match remote's actual default branch.
    // Non-fatal — detectDefaultBranch has its own fallback chain.
    const setHead = await executor.exec(
      "git",
      ["remote", "set-head", "origin", "--auto"],
      { cwd: mainRoot },
    );
    if (setHead.exitCode !== 0) {
      log?.warn(
        { stderr: setHead.stderr },
        "could not auto-detect origin HEAD, using fallback",
      );
    }
    const defaultBranch = await detectDefaultBranch(mainRoot, executor);

    const targetPath = path.join(mainRoot, ".worktrees", name);

    // Check for both directory and branch collision — a previous worktree
    // removal deletes the directory but leaves the branch behind.
    if (await pathExists(executor, targetPath)) {
      return err({
        code: "WORKTREE_NAME_COLLISION",
        name,
        message: `A worktree directory already exists at ${targetPath}`,
      });
    }
    const branchExists = await executor.exec(
      "git",
      ["rev-parse", "--verify", `refs/heads/${name}`],
      { cwd: mainRoot },
    );
    if (branchExists.exitCode === 0) {
      return err({
        code: "WORKTREE_NAME_COLLISION",
        name,
        message: `Branch '${name}' already exists`,
      });
    }

    log?.info(
      { targetPath, branch: name, base: `origin/${defaultBranch}` },
      "creating worktree",
    );
    await gitOutput(executor, mainRoot, [
      "worktree",
      "add",
      targetPath,
      "-b",
      name,
      `origin/${defaultBranch}`,
    ]);

    return ok({ path: targetPath, branch: name });
  } catch (e) {
    return err({
      code: "GIT_FAILED",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Remove a git worktree by path and force-delete its branch. */
export async function worktreeRemove(
  worktreePath: string,
  log?: Logger,
  executor: Executor = localExecutor,
): Promise<GitResult<void>> {
  try {
    const mainRoot = await resolveMainRepoRoot(executor, worktreePath);

    // Detect the branch checked out in this worktree before removing it
    let branch: string | null = null;
    const headRef = await executor.exec(
      "git",
      ["rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: worktreePath },
    );
    if (headRef.exitCode === 0) {
      branch = headRef.stdout.trim();
    }

    log?.info({ mainRoot, worktreePath, branch }, "removing worktree");
    await gitOutput(executor, mainRoot, [
      "worktree",
      "remove",
      worktreePath,
      "--force",
    ]);

    // Clean up the branch (force delete — these are ephemeral Kolu-created branches)
    if (branch && branch !== "HEAD") {
      const del = await executor.exec("git", ["branch", "-D", branch], {
        cwd: mainRoot,
      });
      if (del.exitCode === 0) {
        log?.info({ branch }, "deleted worktree branch");
      } else {
        log?.warn({ branch, stderr: del.stderr }, "could not delete branch");
      }
    }

    return ok(undefined);
  } catch (e) {
    return err({
      code: "GIT_FAILED",
      message: e instanceof Error ? e.message : String(e),
    });
  }
}
