/**
 * AgentProvider — the shared contract every agent-detection integration
 * implements. A provider encapsulates four axes of volatility that vary
 * per agent CLI:
 *
 *  1. How a terminal maps to a session         → `resolveSession`
 *  2. Session-identity derivation               → `sessionKey`
 *  3. Per-session state watching + derivation   → `createWatcher`
 *  4. External signals that may change the match → `externalChanges`
 *     (optional — only agents whose session-match answer can change without
 *     a title event need this; see the field's JSDoc.)
 *
 * Info equality is deliberately NOT part of this interface — it's a property
 * of the AgentInfo union shape, exposed as the free function `agentInfoEqual`
 * below. All concrete AgentInfo variants share the same 5-field shape today
 * (state, sessionId, model, summary, taskProgress), so one equality function
 * suffices for every provider.
 */

import type { GitExecutor } from "kolu-git/executor";
import type { Logger } from "kolu-shared";
import type { TaskProgress } from "./schemas.ts";

/** Re-export the universal executor type so integration packages don't
 *  have to take a direct dep on kolu-git just to reference it. */
export type { GitExecutor as Executor } from "kolu-git/executor";

/** Snapshot of a terminal's observable state, passed to `resolveSession`.
 *  Fields are the inputs every agent's session-matching logic can draw from;
 *  the provider picks the ones it needs (claude-code uses `foregroundPid`,
 *  opencode uses `foregroundBasename` + `cwd`). */
export interface AgentTerminalState {
  /** Foreground process PID, or undefined if unknown. */
  foregroundPid: number | undefined;
  /** Terminal's current working directory. */
  cwd: string;
  /** Foreground process basename (e.g. "opencode", "claude", "vim"), or null
   *  if the PTY process is unknown. Lazy: reading involves a kernel syscall
   *  on darwin (sysctl), so providers that match by PID alone (e.g.
   *  claude-code) avoid invoking it. Idempotent within one snapshot — the
   *  second call returns the cached value without a second syscall. */
  readForegroundBasename: () => string | null;
  /** Agent name parsed from the most recent OSC 633;E preexec hint (e.g.
   *  "codex", "opencode"), or null. Populated by the shell's preexec hook
   *  before the command runs, so it reflects the user's typed command even
   *  when the kernel-level process is an interpreter shim (npm-installed
   *  `codex` shows up as `node` to the kernel). Only set while a command
   *  is actively running — clears to null once the shell is idle at the
   *  prompt again, so stale hints don't outlive the process they name. */
  lastAgentCommandName: string | null;
}

/** Handle returned by `createWatcher`. Callers invoke `destroy()` when the
 *  matched session changes or the provider is torn down. */
export interface AgentWatcher {
  destroy(): void;
}

/** Minimal shape every concrete AgentInfo variant satisfies. Used only to
 *  constrain `agentInfoEqual` — NOT to be extended by integrations directly.
 *  Each integration defines its own full schema (ClaudeCodeInfo, OpenCodeInfo)
 *  which happens to match this shape. */
export interface AgentInfoShape {
  kind: string;
  state: string;
  sessionId: string;
  model: string | null;
  summary: string | null;
  taskProgress: TaskProgress | null;
  /** Running context-window token count for the current session, or null
   *  if the agent doesn't expose telemetry (or hasn't yet produced an
   *  assistant turn). Derivation is per-integration — Claude Code sums
   *  input+cache_creation+cache_read from the latest assistant entry's
   *  `message.usage`; OpenCode reads `tokens.total` from the latest
   *  assistant message. Both collapse to the same scalar meaning. */
  contextTokens: number | null;
}

/** Agent-detection contract. Type parameters: `Session` is the provider's
 *  opaque match result (its lifetime == one matched session); `Info` is the
 *  wire-shape yielded by the watcher.
 *
 *  Every IO-bearing method takes an `executor` — the orchestrator supplies
 *  `localExecutor` for local terminals and the terminal's `Host` for remote
 *  ones. Both implement the same `GitExecutor` (`exec` / `readFile` /
 *  `statMtimeMs` / `watch` / `queryDb`) shape so the provider body is
 *  identical for both. Same code path, two backends. */
export interface AgentProvider<Session, Info extends AgentInfoShape> {
  /** Discriminator matching `Info["kind"]` (e.g. "claude-code", "opencode"). */
  readonly kind: Info["kind"];

  /** Given a snapshot of terminal state, return the currently-matching
   *  session for this agent kind, or null if no session applies. May query
   *  the executor (e.g. opencode hits SQLite) — kept narrow so the
   *  orchestrator can await it on every title / cwd / preexec event without
   *  jank. Returns null fast when the foreground process gate fails so
   *  no IO happens unless this provider's binary is actually running. */
  resolveSession(
    state: AgentTerminalState,
    executor: GitExecutor,
    log: Logger,
  ): Promise<Session | null>;

  /** Stable dedup key for a resolved session. The orchestrator compares
   *  successive `sessionKey(resolveSession(...))` values to decide whether
   *  to replace the running watcher. Must be deterministic and agent-specific
   *  (two sessions from different agents don't need to differ — the kind
   *  field already distinguishes providers). */
  sessionKey(session: Session): string;

  /** Start a watcher for a matched session. `onChange` fires whenever the
   *  derived `Info` changes. The returned handle's `destroy()` must tear
   *  down every resource the watcher owns (fs.watch handles, DB connections,
   *  debounce timers, in-flight async work). */
  createWatcher(
    session: Session,
    executor: GitExecutor,
    onChange: (info: Info) => void,
    log: Logger,
  ): AgentWatcher;

  /** Optional integration with external-change signals — filesystem events,
   *  DB WAL writes, or anything else that can change the answer of
   *  `resolveSession` without a title event. If an agent's match depends
   *  only on title-event-triggered state (foreground process, cwd), omit
   *  this field; the orchestrator just skips the wiring.
   *
   *  Must NOT be used for per-session state changes — those are the
   *  responsibility of the watcher returned by `createWatcher`.
   *
   *  Activation is per-executor. The orchestrator memo-keys on
   *  `{ kind, executorId }` and installs at most once per executor (a
   *  fresh machine where the user has never run this agent pays no
   *  watcher cost). `isPresent` may probe filesystem state via the
   *  executor (the watcher install needs the relevant directory to
   *  exist on the same backend the watcher will fire from). */
  externalChanges?: {
    /** True if this agent is (or might soon be) relevant on this executor's
     *  backend — either because the foreground process is (or looks like)
     *  this agent, or because its on-disk state is already present (the
     *  user has used the agent here before, even if no terminal currently
     *  hosts it). Called on every reconcile; the first `true` across any
     *  terminal for this provider+executor triggers `install`. */
    isPresent(
      state: AgentTerminalState,
      executor: GitExecutor,
    ): Promise<boolean>;
    /** Install the per-executor watcher and wire its events to `onChange`.
     *  Called at most once per executor. `onError` receives exceptions
     *  thrown by `onChange`. */
    install(
      executor: GitExecutor,
      onChange: () => void,
      onError: (err: unknown) => void,
      log: Logger,
    ): Promise<{ stop(): void }>;
  };
}

/** True if the preexec hint or the kernel basename names `agentName`.
 *  Preexec hint comes first so interpreter-shim matches skip the darwin
 *  sysctl inside `readForegroundBasename`. */
export function matchesAgent(
  state: AgentTerminalState,
  agentName: string,
): boolean {
  return (
    state.lastAgentCommandName === agentName ||
    state.readForegroundBasename() === agentName
  );
}

/** Structural equality over the shared 5-field AgentInfo shape, plus `kind`.
 *  One implementation serves every provider — if a new integration wants a
 *  different equality contract, its Info shape is out of bounds anyway and
 *  needs to be addressed schema-side, not by forking the comparator. */
export function agentInfoEqual<A extends AgentInfoShape>(
  a: A | null,
  b: A | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.kind !== b.kind) return false;
  if (a.state !== b.state) return false;
  if (a.sessionId !== b.sessionId) return false;
  if (a.model !== b.model) return false;
  if (a.summary !== b.summary) return false;
  if (a.contextTokens !== b.contextTokens) return false;
  return taskProgressEqual(a.taskProgress, b.taskProgress);
}

function taskProgressEqual(
  a: TaskProgress | null,
  b: TaskProgress | null,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.total === b.total && a.completed === b.completed;
}
