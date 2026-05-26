/**
 * Remote fs provider — `FsProvider` impl that proxies `listAll`,
 * `readFile`, and `statFileMtimeMs` to the remote agent's
 * `fs.listAll` / `fs.readFile` / `fs.statFileMtimeMs` RPCs.
 *
 * Phase 2b of kolu#951. Each call is a single round-trip; the agent
 * runs the LOCAL `kolu-git` `listAll` / `readFile` / `statFileMtimeMs`
 * against the remote filesystem.
 *
 * **Prototype scope.** The agent-side handlers for these methods are
 * stubbed in `kolu-remote-agent/src/index.ts` (TODO Phase 2b in that
 * file). Once those land, this client compiles and dispatches
 * end-to-end with no changes here.
 */

import type { FsProvider, GitResult } from "kolu-git";
import type { Logger } from "kolu-shared";
import type { HostSessionLike } from "./host-session.ts";

/** Minimal runtime guard at the wire boundary. The agent's handlers
 *  return `GitResult<T>` by construction (they run the LOCAL fs
 *  provider), but the wire payload arrives here as `unknown`.
 *  Throwing on a malformed shape is strictly better than letting a
 *  corrupted GitResult flow into downstream null-dereferences. A
 *  full Zod schema in `kolu-remote-agent/protocol.ts` per fs result
 *  would be the ideal fix once Phase 2b's agent handlers land — for
 *  now this catches structural drift loudly. */
function assertGitResultShape<T>(value: unknown, method: string): GitResult<T> {
  if (value === null || typeof value !== "object" || !("ok" in value)) {
    throw new Error(
      `remoteFsProvider.${method}: agent returned non-GitResult shape`,
    );
  }
  return value as GitResult<T>;
}

export function remoteFsProvider(session: HostSessionLike): FsProvider {
  return {
    async listAll(
      repoPath: string,
      _log?: Logger,
    ): Promise<GitResult<string[]>> {
      const result = await session.call("fs.listAll", { repoPath });
      return assertGitResultShape<string[]>(result, "listAll");
    },
    async readFile(
      repoPath: string,
      filePath: string,
      _log?: Logger,
    ): Promise<GitResult<{ content: string; truncated: boolean }>> {
      const result = await session.call("fs.readFile", { repoPath, filePath });
      return assertGitResultShape<{ content: string; truncated: boolean }>(
        result,
        "readFile",
      );
    },
    async statFileMtimeMs(
      repoPath: string,
      filePath: string,
      _log?: Logger,
    ): Promise<GitResult<number>> {
      const result = await session.call("fs.statFileMtimeMs", {
        repoPath,
        filePath,
      });
      return assertGitResultShape<number>(result, "statFileMtimeMs");
    },
  };
}
