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

import { type GitInfoProvider, localGitInfoProvider } from "kolu-git";
import { remoteGitInfoProvider } from "kolu-remote-client";
import { trackRecentRepo } from "../activity.ts";
import { getReadySession } from "../agent/host-registry.ts";
import { log } from "../log.ts";
import { terminalChannels } from "../publisher.ts";
import type { TerminalProcess } from "../terminal-registry.ts";
import { updateServerMetadata } from "./state.ts";

export function startGitProvider(
  entry: TerminalProcess,
  terminalId: string,
): () => void {
  const plog = log.child({ provider: "git", terminal: terminalId });
  plog.debug({ cwd: entry.meta.cwd, location: entry.meta.location }, "started");

  // Phase 2b dispatch: local terminals run kolu-git locally; SSH
  // terminals proxy through the host's `HostSession` to the agent.
  // The registry hands us a `HostSessionLike` with defer-until-ready
  // baked in — no inline plumbing here.
  const loc = entry.meta.location;
  const host: string | null = loc.kind === "ssh" ? loc.host : null;
  const provider: GitInfoProvider =
    loc.kind === "ssh"
      ? remoteGitInfoProvider(getReadySession(loc.host, log))
      : localGitInfoProvider;

  const watcher = provider.subscribe(
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
