/**
 * Codex's AgentProvider — IO-routed through an executor so the same
 * body runs against the controller's local fs and a remote SSH `Host`.
 *
 * `externalChanges` IS implemented here — unlike OpenCode, Codex can
 * have a running `codex` TUI process whose thread row doesn't exist in
 * SQLite until the first exchange completes. A bare title event won't
 * fire at that moment, so we also rewake on every WAL write and let
 * `resolveSession` re-check the DB. When the thread appears, match
 * succeeds. `isPresent` gates `install` on either (a) the binary being
 * foregrounded in some terminal, or (b) `~/.codex` existing on the
 * executor's filesystem already (user has used Codex on this machine
 * before). Neither holds on a fresh machine that has never run Codex —
 * no watcher, no logs, no missing-directory error (issue #698).
 */

import { type AgentProvider, matchesAgent } from "anyagent";
import { resolveCodexDirs } from "./config.ts";
import { type CodexSession, findSessionByDirectory } from "./core.ts";
import type { CodexInfo } from "./schemas.ts";
import { createCodexWatcher } from "./session-watcher.ts";
import { subscribeCodexDb } from "./wal-watcher.ts";

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
      const dirs = await resolveCodexDirs(executor);
      if (!dirs.dir) return false;
      // `statMtimeMs` doubles as an existence probe (rejects when the
      // path is missing). Catch-all means we treat any failure
      // (missing dir, EACCES, …) as "not present" — same observable
      // outcome the old `fs.existsSync` had.
      try {
        await executor.statMtimeMs(dirs.dir);
        return true;
      } catch {
        return false;
      }
    },
    async install(executor, onChange, onError, log) {
      // Bridge `subscribeCodexDb`'s legacy `() => void` unsubscribe to
      // the new contract's `{ stop(): void }` handle.
      const unsubscribe = subscribeCodexDb(executor, onChange, onError, log);
      return { stop: unsubscribe };
    },
  },
};
