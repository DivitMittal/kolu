/**
 * Git metadata provider — thin adapter around `GitInfoProvider` from
 * kolu-git. The resolve + HEAD-watch + re-resolve loop lives in the
 * integration; this file wires the loop into the server's channels:
 *
 *   cwd:<id>        → watcher.setCwd
 *   onChange(info)  → trackRecentRepo + updateServerMetadata + publish git:<id>
 *
 * The published payload is wrapped in `HostTagged<GitInfo>` so downstream
 * consumers (`meta/github.ts`) can guard on origin host before treating
 * paths as locally resolvable.
 *
 * Phase 0 short-circuits non-local terminals — running
 * `localGitInfoProvider` against a remote-host cwd would silently publish
 * locally-resolved git info for a remote path. Phase 2b will replace the
 * early-return with proper dispatch (`localGitInfoProvider` vs.
 * `remoteGitInfoProvider`) once the remote variant exists. Symmetric
 * with the same skip in `meta/agent.ts`, `meta/github.ts`, and
 * `meta/process.ts`.
 *
 * Downstream providers (github) subscribe to `git:<id>` for branch/repo
 * deltas without needing to know about cwd-change semantics.
 */

import { localGitInfoProvider } from "kolu-git";
import { trackRecentRepo } from "../activity.ts";
import { log } from "../log.ts";
import { terminalChannels } from "../publisher.ts";
import type { TerminalProcess } from "../terminal-registry.ts";
import { updateServerMetadata } from "./state.ts";

export function startGitProvider(
  entry: TerminalProcess,
  terminalId: string,
): () => void {
  const plog = log.child({ provider: "git", terminal: terminalId });

  // Local kernel reads only — `localGitInfoProvider` resolves cwd against
  // the local filesystem. For an SSH-wrapped tile that's the wrong
  // machine. Skip cleanly until Phase 2b lands `remoteGitInfoProvider`.
  // Matches the early-return pattern in agent/github/process.
  if (entry.meta.location.kind !== "local") {
    plog.debug({ location: entry.meta.location }, "skipping non-local");
    return () => {};
  }

  plog.debug({ cwd: entry.meta.cwd }, "started");

  // Only local terminals reach this point in Phase 0, so the host tag on
  // the wrapped channel payload is unconditionally null. Phase 2b will
  // resolve it from `entry.meta.location` when the dispatch grows the
  // remote branch.
  const host: string | null = null;

  const watcher = localGitInfoProvider.subscribe(
    entry.meta.cwd,
    (git) => {
      if (git) trackRecentRepo(git.mainRepoRoot, git.repoName);
      updateServerMetadata(entry, terminalId, (m) => {
        m.git = git;
      });
      terminalChannels.git(terminalId).publish({ host, payload: git });
      plog.debug(
        { repo: git?.repoName, branch: git?.branch },
        "git info updated",
      );
    },
    plog,
  );

  const cleanup = terminalChannels.cwd(terminalId).consume({
    onEvent: (cwd) => watcher.setCwd(cwd),
    onError: (err) => plog.error({ err }, "publisher subscription failed"),
  });

  return () => {
    cleanup();
    watcher.stop();
    plog.debug("stopped");
  };
}
