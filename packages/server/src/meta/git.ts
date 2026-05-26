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
import { getHostSession } from "../agent/host-registry.ts";
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
  const host: string | null =
    entry.meta.location.kind === "ssh" ? entry.meta.location.host : null;
  let provider: GitInfoProvider;
  if (entry.meta.location.kind === "ssh") {
    const cached = getHostSession(entry.meta.location.host, log);
    // The session may still be connecting on first call; the
    // RemoteGitInfoProvider's subscribe IS synchronous, but the
    // underlying RPC waits on the session's ready promise behind the
    // scenes. (Phase 2a placeholder throws if RPC fires before ready;
    // we wrap in a one-tick await below.)
    provider = remoteGitInfoProvider({
      call: async (method, args) => {
        await cached.ready;
        return cached.session.call(method, args);
      },
      subscribe: (method, args, onEvent) => {
        // Defer issuing the subscription until the session is ready —
        // wrap in a token that buffers update/close until then.
        let inner: ReturnType<typeof cached.session.subscribe> | null = null;
        const pendingUpdates: unknown[] = [];
        let pendingClose = false;
        void cached.ready.then(() => {
          if (pendingClose) return;
          inner = cached.session.subscribe(method, args, onEvent);
          for (const params of pendingUpdates) void inner.update(params);
        });
        return {
          update: async (params) => {
            if (inner) await inner.update(params);
            else pendingUpdates.push(params);
          },
          close: async () => {
            pendingClose = true;
            if (inner) await inner.close();
          },
        };
      },
    });
  } else {
    provider = localGitInfoProvider;
  }

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
