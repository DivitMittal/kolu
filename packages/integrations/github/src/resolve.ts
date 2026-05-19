/** Runtime resolver — spawns `gh pr view`, classifies failures, owns the
 *  branch-change + polling loop. Node-only (uses `node:child_process`);
 *  browser-bound callers should import only from `./schemas.ts` via the
 *  `kolu-common/pr` subpath, which re-exports schemas + display helpers but
 *  not this module. */

/* Generic exec abstraction — kolu-git's `GitExecutor` is structurally
 * a strict superset, so kolu-server's `Host` and kolu-git's
 * `localExecutor` both satisfy it. Defined inline (rather than imported
 * from kolu-git) to keep this package leaf — kolu-github should not
 * grow a dependency on kolu-git just to share an interface name.
 *
 * One executor for both local and remote. The previous KOLU_GH_BIN
 * fallback for local was a divergent code path — kolu's Nix wrapper
 * already puts `gh` on PATH (and the `kolu-helper` derivation does the
 * same on remote), so `executor.exec("gh", ...)` works against either
 * backend without a fork. */
export interface GhExecutor {
  exec(
    cmd: string,
    args: string[],
    opts?: { cwd?: string; timeoutMs?: number; maxBytes?: number },
  ): Promise<{ stdout: string; stderr: string; exitCode: number | null }>;
}

import type { Logger } from "kolu-shared";
import { classifyGhError, deriveCheckStatus, prResultEqual } from "./github.ts";
import { GitHubPrStateSchema, type PrResult } from "./schemas.ts";

const POLL_INTERVAL_MS = 30_000;
const GH_TIMEOUT_MS = 5_000;

/** Shape returned by `gh pr view --json ...`. */
interface GhPrViewResult {
  number: number;
  title: string;
  url: string;
  state: string;
  statusCheckRollup?: Parameters<typeof deriveCheckStatus>[0];
}

/** Look up the GitHub PR for the current branch.
 *
 *  Uses `gh pr view` which resolves via git remote tracking — it finds the
 *  PR opened from this repo (or fork) for the current branch, unlike
 *  `gh pr list --head <name>` which matches by branch name alone and picks
 *  up unrelated fork PRs.
 *
 *  Logs failures at the appropriate level when a logger is passed:
 *  absent→debug (expected), unknown→error (actual bug), other→warn
 *  (degraded-but-recoverable). */
export async function resolveGitHubPr(
  repoRoot: string,
  executor: GhExecutor,
  log?: Logger,
): Promise<PrResult> {
  try {
    const r = await executor.exec(
      "gh",
      ["pr", "view", "--json", "number,title,url,state,statusCheckRollup"],
      { cwd: repoRoot, timeoutMs: GH_TIMEOUT_MS },
    );
    if (r.exitCode !== 0) {
      const e: Error & { stderr?: string; code?: number } = new Error(
        r.stderr.trim() || `gh exited ${r.exitCode}`,
      );
      e.stderr = r.stderr;
      e.code = r.exitCode ?? undefined;
      const result = classifyGhError(e);
      if (log) logGhResolveFailure(e, result, log);
      return result;
    }
    const data = JSON.parse(r.stdout) as GhPrViewResult;
    return {
      kind: "ok",
      value: {
        number: data.number,
        title: data.title,
        url: data.url,
        state: GitHubPrStateSchema.parse(data.state.toLowerCase()),
        checks: deriveCheckStatus(data.statusCheckRollup),
      },
    };
  } catch (err) {
    const result = classifyGhError(err);
    if (log) logGhResolveFailure(err, result, log);
    return result;
  }
}

/** Route a failed `gh pr view` result to the appropriate log level.
 *  absent = expected (branch has no PR) → debug.
 *  unavailable with code `unknown` = an actual unexpected error → error.
 *  unavailable with any other code = degraded-but-recoverable → warn. */
function logGhResolveFailure(
  err: unknown,
  result: PrResult,
  log: Logger,
): void {
  const ctx = { err: String(err), result: result.kind };
  if (result.kind === "absent") {
    log.debug(ctx, "gh pr view: no PR for branch");
    return;
  }
  if (result.kind === "unavailable" && result.source.code === "unknown") {
    log.error(ctx, "gh pr view: unknown error");
    return;
  }
  log.warn(
    result.kind === "unavailable" ? { ...ctx, code: result.source.code } : ctx,
    "gh pr view: unavailable",
  );
}

/** Watcher handle returned by `subscribeGitHubPr`. */
export interface GitHubPrWatcher {
  /** Feed the latest git state. Repo+branch dedup happens internally; a
   *  real change triggers a synchronous `{ kind: "pending" }` emit followed
   *  by an async resolve that emits the result. Pass `null`s when the
   *  terminal leaves a repo. */
  setGit: (repoRoot: string | null, branch: string | null) => void;
  /** Cancel the poll timer and stop accepting updates. */
  stop: () => void;
}

/** Subscribe to GitHub PR changes for a terminal.
 *
 *  Mirrors `kolu-git`'s `subscribeGitInfo` shape: the caller wires the
 *  watcher to its own git source (channel subscription, signal, whatever)
 *  via `setGit`, and receives resolved `PrResult` values through `onChange`.
 *
 *  Owns: branch-change dedup (via `prResultEqual`), pending emission on
 *  branch change (so stale PR info doesn't linger while `gh pr view` is in
 *  flight), and a 30s polling loop that re-resolves on the last-seen
 *  repo/branch (PRs can be created/updated externally).
 *
 *  Does not own: the git source, metadata publishing, terminal lifecycle —
 *  those stay with the caller. */
export function subscribeGitHubPr(
  executor: GhExecutor,
  onChange: (pr: PrResult) => void,
  log?: Logger,
): GitHubPrWatcher {
  let lastBranch: string | null = null;
  let lastRepoRoot: string | null = null;
  let lastPr: PrResult = { kind: "pending" };
  let stopped = false;

  function emit(pr: PrResult): void {
    if (stopped || prResultEqual(pr, lastPr)) return;
    lastPr = pr;
    onChange(pr);
  }

  async function fetchAndEmit(repoRoot: string): Promise<void> {
    const pr = await resolveGitHubPr(repoRoot, executor, log);
    emit(pr);
  }

  function setGit(repoRoot: string | null, branch: string | null): void {
    if (branch === lastBranch && repoRoot === lastRepoRoot) return;
    log?.debug(
      { from: lastBranch, to: branch },
      "branch changed, re-resolving",
    );
    lastBranch = branch;
    lastRepoRoot = repoRoot;
    // Emit pending so stale PR info doesn't linger while resolve is in
    // flight. If we already last-emitted pending, dedup inside `emit`
    // makes this a no-op.
    emit({ kind: "pending" });
    if (branch && repoRoot) void fetchAndEmit(repoRoot);
  }

  const pollTimer = setInterval(() => {
    if (lastBranch && lastRepoRoot) {
      log?.debug({ branch: lastBranch }, "poll tick");
      void fetchAndEmit(lastRepoRoot);
    }
  }, POLL_INTERVAL_MS);

  return {
    setGit,
    stop: () => {
      stopped = true;
      clearInterval(pollTimer);
      log?.debug({ branch: lastBranch }, "stopped");
    },
  };
}
