/**
 * Claude Code's AgentProvider — wires `readSessionFile` +
 * `subscribeSessionsDir` + `createSessionWatcher` into the shared
 * `AgentProvider` contract. Every IO operation flows through the
 * `executor` parameter so local and remote use the same code path.
 *
 * `externalChanges.isPresent` gates `install` on either (a) `claude`
 * being foregrounded in some terminal, or (b) `~/.claude/sessions/`
 * existing on the executor's filesystem. Matching is not PID-based
 * here — `resolveSession` returns null until claude writes its session
 * file, which is exactly what the SESSIONS_DIR watcher fires on — so we
 * need a cheaper "might be running here" signal to authorize the
 * watcher install.
 */

import { type AgentProvider, matchesAgent } from "anyagent";
import {
  readSessionFile,
  resolveClaudeDirs,
  type SessionFile,
  subscribeSessionsDir,
} from "./core.ts";
import type { ClaudeCodeInfo } from "./schemas.ts";
import { createSessionWatcher } from "./session-watcher.ts";

export const claudeCodeProvider: AgentProvider<SessionFile, ClaudeCodeInfo> = {
  kind: "claude-code",

  async resolveSession(state, executor, log) {
    if (state.foregroundPid === undefined) return null;
    return readSessionFile(state.foregroundPid, executor, log);
  },

  sessionKey(session) {
    return session.sessionId;
  },

  createWatcher(session, executor, onChange, log) {
    return createSessionWatcher(session, executor, onChange, log);
  },

  externalChanges: {
    async isPresent(state, executor) {
      if (matchesAgent(state, "claude")) return true;
      const dirs = await resolveClaudeDirs(executor);
      if (!dirs) return false;
      try {
        await executor.statMtimeMs(dirs.sessionsDir);
        return true;
      } catch {
        return false;
      }
    },
    install(executor, onChange, onError, log) {
      return subscribeSessionsDir(executor, onChange, onError, log);
    },
  },
};
