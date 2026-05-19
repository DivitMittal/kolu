/**
 * OpenCode's AgentProvider — wires the package's helpers into the shared
 * `AgentProvider` contract from anyagent.
 *
 * Every IO operation flows through the `executor` parameter — the
 * orchestrator passes `localExecutor` for local terminals and the SSH
 * `Host` for remote ones. Identical code, two backends.
 *
 * `externalChanges` is intentionally omitted: OpenCode's TUI owns its
 * session throughout its lifetime, and the session appears in the DB
 * only after the first user exchange. By then a title event has already
 * fired (the user typed a command boundary), so re-resolving on title
 * covers the appearance case. WAL changes are per-session state, owned
 * by `createOpenCodeWatcher`, not session-identity changes.
 */

import { type AgentProvider, matchesAgent } from "anyagent";
import { findSessionByDirectory, type OpenCodeSession } from "./core.ts";
import type { OpenCodeInfo } from "./schemas.ts";
import { createOpenCodeWatcher } from "./session-watcher.ts";

export const opencodeProvider: AgentProvider<OpenCodeSession, OpenCodeInfo> = {
  kind: "opencode",

  async resolveSession(state, executor, log) {
    // Foreground gate: only hit the DB if the user actually has opencode
    // running in this terminal. Local and remote both honor this — no
    // unconditional polling, no "stuck on detected" zombies.
    if (!matchesAgent(state, "opencode")) return null;
    return findSessionByDirectory(state.cwd, executor, log);
  },

  sessionKey(session) {
    return session.id;
  },

  createWatcher(session, executor, onChange, log) {
    return createOpenCodeWatcher(session, executor, onChange, log);
  },
};
