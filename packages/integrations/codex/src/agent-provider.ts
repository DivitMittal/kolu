/**
 * Codex's AgentProvider — IO-routed through an executor so the same body
 * runs against the controller's local fs and a remote SSH `Host`.
 *
 * `externalChanges` IS implemented because Codex can have a running
 * `codex` TUI process whose thread row doesn't exist in SQLite until the
 * first exchange completes. A bare title event won't fire at that
 * moment, so we also rewake on every WAL write and let `resolveSession`
 * re-check the DB. `isPresent` gates `install` on either (a) the binary
 * being foregrounded, or (b) `~/.codex` existing on the executor's
 * filesystem.
 */

import { type AgentProvider, matchesAgent } from "anyagent";
import {
  type CodexSession,
  findSessionByDirectory,
  resolveCodexDbPath,
  resolveCodexDir,
} from "./core.ts";
import type { CodexInfo } from "./schemas.ts";
import { createCodexWatcher } from "./session-watcher.ts";

export const codexProvider: AgentProvider<CodexSession, CodexInfo> = {
  kind: "codex",

  async resolveSession(state, executor, log) {
    if (!matchesAgent(state, "codex")) return null;
    return findSessionByDirectory(state.cwd, executor, log);
  },

  sessionKey(session) {
    return session.id;
  },

  createWatcher(session, executor, onChange, log) {
    return createCodexWatcher(session, executor, onChange, log);
  },

  externalChanges: {
    async isPresent(state, executor) {
      if (matchesAgent(state, "codex")) return true;
      const dir = await resolveCodexDir(executor);
      if (!dir) return false;
      try {
        await executor.statMtimeMs(dir);
        return true;
      } catch {
        return false;
      }
    },
    async install(executor, onChange, onError, log) {
      // Watch the codex DB's WAL so new sessions appearing in any
      // terminal under this executor trigger a re-resolve. The watcher
      // installs once per executor (the orchestrator memo-keys on
      // executor identity), so multiple terminals sharing a host don't
      // spawn duplicate watchers.
      const dbPath = await resolveCodexDbPath(executor, log);
      if (!dbPath) return { stop: () => {} };
      try {
        const handle = await executor.watch(
          `${dbPath}-wal`,
          () => {
            try {
              onChange();
            } catch (err) {
              onError(err);
            }
          },
          { recursive: false },
        );
        return handle;
      } catch (err) {
        log?.debug({ err, dbPath }, "codex external WAL watch failed");
        return { stop: () => {} };
      }
    },
  },
};
