/**
 * OpenCodeWatcher — encapsulates all per-session lifecycle state.
 *
 * Lifecycle:
 *   1. Subscribe to the OpenCode WAL file via `subscribeOpenCodeDb`.
 *      That helper currently runs against the controller's local fs
 *      (kolu-shared/sqlite's refcounted singleton); a future refactor
 *      will push the executor down through it, but the *contract*
 *      already accepts an executor so callers don't need to change
 *      when the upstream shift lands.
 *   2. Debounce the WAL-change burst (OpenCode streams parts during
 *      generation, fs.watch fires multiple events per write).
 *   3. On each debounced tick: re-read the session's latest message +
 *      task progress + token count via `executor.queryDb`, derive the
 *      `OpenCodeInfo`, and emit it if it differs from the last one.
 *
 * No polling. The watcher is event-driven: a fresh PTY that hasn't
 * touched opencode pays zero refresh traffic.
 */

import { type AgentWatcher, agentInfoEqual } from "anyagent";
import type { Executor } from "kolu-io";
import type { Logger } from "kolu-shared";
import {
  deriveSessionState,
  getLatestAssistantContextTokens,
  getSessionTaskProgress,
  getSessionTitle,
  type OpenCodeSession,
  runningToolsBucket,
} from "./core.ts";
import type { OpenCodeInfo } from "./schemas.ts";
import { subscribeOpenCodeDb } from "./wal-watcher.ts";

// --- Tuning constants ---

/** Trailing-edge debounce for WAL change callbacks. OpenCode streams
 *  parts during generation, and Linux fs.watch fires multiple events per
 *  write — without debouncing, `refresh` runs dozens of times per second
 *  during active use, each call running multiple SQL queries. 150 ms
 *  coalesces bursts into one handler run while keeping user-perceptible
 *  lag imperceptible. Matches TRANSCRIPT_DEBOUNCE_MS in kolu-claude-code. */
const WAL_DEBOUNCE_MS = 150;

// --- Watcher ---

export interface OpenCodeWatcher extends AgentWatcher {
  readonly session: OpenCodeSession;
}

/**
 * Start watching an OpenCode session. Reads the latest message immediately
 * and emits an initial state, then re-reads on every WAL file change
 * (debounced) and emits a new state if it differs from the last one.
 *
 * `executor` is the IO seam: `localExecutor` for local terminals, the
 * terminal's `Host` for remote ones. Both implement `queryDb`, so the
 * body below doesn't branch on backend.
 *
 * `onChange` is called with the full OpenCodeInfo each time state changes.
 * The caller is responsible for forwarding it to the metadata system.
 */
export function createOpenCodeWatcher(
  session: OpenCodeSession,
  executor: Executor,
  onChange: (info: OpenCodeInfo) => void,
  log?: Logger,
): OpenCodeWatcher {
  let last: OpenCodeInfo | null = null;
  let stopped = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let unsubscribe: (() => void) | null = null;
  // Coalesce overlapping refresh calls. WAL events can fire faster than
  // the SQL reads complete; without these flags we'd start a new refresh
  // while the previous one's awaits were still in flight and clobber
  // each other's `last` snapshot.
  let pending = false;
  let inFlight = false;

  async function refresh(): Promise<void> {
    if (stopped) return;
    if (inFlight) {
      // A refresh is already running; mark a follow-up. The current run
      // will re-check the flag and re-fire if set.
      pending = true;
      return;
    }
    inFlight = true;
    try {
      const derived = await deriveSessionState(
        session.id,
        session.dbPath,
        executor,
        log,
      );
      if (stopped) return;
      if (!derived) {
        log?.debug(
          { session: session.id },
          "no messages yet for opencode session",
        );
        return;
      }

      // Fan out the three follow-up reads in parallel — they're
      // independent queries against the same DB and each is dominated
      // by IO latency. On localExecutor this is cheap; on a remote
      // backend it collapses four round-trips into one wall-clock
      // window.
      //
      // When the assistant is actively generating (state === "thinking"),
      // classify the current message's running tool parts to distinguish
      // tool execution from LLM generation — and within tool execution,
      // separate "blocked on user question" from real compute. Scoped to
      // derived.messageId (the latest message) — not the entire session
      // — so we only scan the handful of current-turn parts.
      const [toolBucket, taskProgress, titleFromDb, contextTokens] =
        await Promise.all([
          derived.state === "thinking"
            ? runningToolsBucket(
                derived.messageId,
                session.dbPath,
                executor,
                log,
              )
            : Promise.resolve(null),
          getSessionTaskProgress(session.id, session.dbPath, executor, log),
          // Re-read title on each refresh so mid-conversation title
          // changes (e.g. OpenCode auto-generating a title after the
          // first exchange) are picked up live, not stuck at the
          // snapshot from session match.
          getSessionTitle(session.id, session.dbPath, executor, log),
          // Context-token total comes from its own query — the latest
          // assistant message's tokens.total, which survives a newer
          // user prompt (Thinking state). Using derived.state's
          // single-message lens would blank the count whenever the
          // user is typing.
          getLatestAssistantContextTokens(
            session.id,
            session.dbPath,
            executor,
            log,
          ),
        ]);
      if (stopped) return;

      const state =
        derived.state === "thinking"
          ? (toolBucket ?? derived.state)
          : derived.state;

      const info: OpenCodeInfo = {
        kind: "opencode",
        state,
        sessionId: session.id,
        model: derived.model,
        summary: titleFromDb ?? session.title,
        taskProgress,
        contextTokens,
      };
      if (agentInfoEqual(info, last)) return;
      last = info;
      log?.debug(
        { state: info.state, model: info.model, session: info.sessionId },
        "opencode state updated",
      );
      onChange(info);
    } catch (err) {
      log?.debug({ err, session: session.id }, "opencode refresh failed");
    } finally {
      inFlight = false;
      if (pending && !stopped) {
        pending = false;
        // Schedule the follow-up off the microtask queue so we don't grow
        // the call stack arbitrarily during a burst.
        setTimeout(() => void refresh(), 0);
      }
    }
  }

  function scheduleRefresh(): void {
    if (stopped) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void refresh();
    }, WAL_DEBOUNCE_MS);
  }

  // Install the WAL subscription (refcounted singleton, lives in
  // wal-watcher.ts) and fire an initial refresh. The subscription's
  // local backend ignores the executor today; the parameter exists so
  // the call site doesn't need to change when the upstream refactor
  // pushes the executor down into kolu-shared/sqlite.
  unsubscribe = subscribeOpenCodeDb(
    executor,
    () => scheduleRefresh(),
    (err) => log?.error({ err, session: session.id }, "opencode WAL cb threw"),
    log,
  );
  void refresh();

  return {
    session,
    destroy: () => {
      stopped = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}
