/**
 * Remote-host GitHub PR fetcher — replacement for `subscribeGitHubPr`
 * when the terminal's PTY (and therefore its `git` + `gh` invocations)
 * live on another machine. The local `kolu-github` shells out to `gh
 * pr view --cwd <repo>` against the controller's local fs; on remote
 * that path doesn't exist and the PR pane is stuck on "unavailable".
 *
 * v0 trade-off: route `gh` through `host.exec`. The remote needs `gh`
 * on PATH and logged in (gh is bundled in the kolu Nix install, so
 * any host that runs `nix run github:juspay/kolu/#kolu-helper` already
 * has it available). Same 30s polling cadence as the local watcher.
 */

import { classifyGhError, deriveCheckStatus, prResultEqual } from "kolu-github";
import { GitHubPrStateSchema, type PrResult } from "kolu-github/schemas";
import type { Host } from "../host/types.ts";
import type { Logger } from "../log.ts";

const POLL_INTERVAL_MS = 30_000;
const GH_TIMEOUT_MS = 15_000;

/** Shape we read from `gh pr view --json …`. Subset of the full
 *  response; mirrors `GhPrViewResult` in `kolu-github/resolve.ts`. */
interface GhPrViewResult {
  number: number;
  title: string;
  url: string;
  state: string;
  statusCheckRollup?: Parameters<typeof deriveCheckStatus>[0];
}

async function fetchRemotePr(
  host: Host,
  repoRoot: string,
  log: Logger,
): Promise<PrResult> {
  let stdout = "";
  let stderr = "";
  try {
    const result = await host.exec(
      "gh",
      ["pr", "view", "--json", "number,title,url,state,statusCheckRollup"],
      { cwd: repoRoot, timeoutMs: GH_TIMEOUT_MS, maxBytes: 256_000 },
    );
    stdout = result.stdout;
    stderr = result.stderr;
    if (result.exitCode !== 0) {
      // Surface gh's stderr to the classifier the same way the local
      // path does — `classifyGhError` discriminates "no PR for branch"
      // from "auth required" from "rate-limited" by sniffing stderr.
      const err: Error & { stderr?: string; code?: number } = new Error(
        `gh exited ${result.exitCode}: ${stderr.trim()}`,
      );
      err.stderr = stderr;
      err.code = result.exitCode ?? undefined;
      const classified = classifyGhError(err);
      log.debug(
        { branch: repoRoot, exitCode: result.exitCode, kind: classified.kind },
        "remote gh pr view: non-zero",
      );
      return classified;
    }
    const data = JSON.parse(stdout) as GhPrViewResult;
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
    log.warn({ err, stderr }, "remote gh pr view: unexpected error");
    return classifyGhError(err);
  }
}

export interface RemotePrWatcher {
  setGit(repoRoot: string | null, branch: string | null): void;
  stop(): void;
}

export function startRemotePr(
  host: Host,
  onChange: (pr: PrResult) => void,
  log: Logger,
): RemotePrWatcher {
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
    const pr = await fetchRemotePr(host, repoRoot, log);
    emit(pr);
  }

  function setGit(repoRoot: string | null, branch: string | null): void {
    if (branch === lastBranch && repoRoot === lastRepoRoot) return;
    lastBranch = branch;
    lastRepoRoot = repoRoot;
    emit({ kind: "pending" });
    if (branch && repoRoot) void fetchAndEmit(repoRoot);
  }

  const pollTimer = setInterval(() => {
    if (lastBranch && lastRepoRoot) void fetchAndEmit(lastRepoRoot);
  }, POLL_INTERVAL_MS);

  return {
    setGit,
    stop: () => {
      stopped = true;
      clearInterval(pollTimer);
    },
  };
}
