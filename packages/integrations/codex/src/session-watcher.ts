/**
 * CodexWatcher — encapsulates all per-session lifecycle state.
 *
 * Lifecycle (no polling — fully push-driven through `executor.watch`):
 *  1. Install `executor.watch` on the rollout JSONL (catches state-changing
 *     turn events) AND on the SQLite WAL (catches title / model row touches).
 *  2. Debounce the change bursts (Codex appends multiple lines per turn).
 *  3. On each debounced tick: stat the rollout via `executor.statMtimeMs`;
 *     if mtime is unchanged from the cached value, skip the heavy tail
 *     read — this catches the "WAL touched but rollout didn't" case
 *     (DB-only writes like title updates).
 *  4. Otherwise: tail the rollout via the executor, derive state, assemble
 *     `CodexInfo`, and emit when it differs from the last one.
 *
 * Data flow per WAL/rollout event (inside the debounce):
 *   1. re-read `threads.{title, model}` via `executor.queryDb`
 *   2. tail the matched rollout JSONL (last TAIL_BYTES) via
 *      `executor.exec("tail", ["-c", …])` — skipped when the file mtime
 *      is unchanged from the last parse
 *   3. assemble CodexInfo and gate dispatch on `agentInfoEqual`
 *
 * The mtime-cache short-circuit (was size-keyed before the executor
 * refactor — `Executor` exposes mtime, not size) is the hot-path
 * optimization that keeps DB-only WAL events from re-reading + re-parsing
 * 256 KB of JSONL on every fire.
 */

import { type AgentWatcher, agentInfoEqual } from "anyagent";
import type { Executor } from "kolu-io";
import type { Logger } from "kolu-shared";
import {
  type CodexSession,
  getThreadMetadata,
  parseRolloutContextTokens,
  parseRolloutState,
  readRolloutTail,
} from "./core.ts";
import type { CodexInfo } from "./schemas.ts";

// --- Tuning constants ---

/** Trailing-edge debounce for watch callbacks. Codex writes a WAL frame
 *  and appends a JSONL line on every thread mutation; during active
 *  generation these fire several times per second. 150 ms coalesces
 *  bursts into one handler run while staying imperceptible. Matches
 *  WAL_DEBOUNCE_MS in kolu-opencode and TRANSCRIPT_DEBOUNCE_MS in
 *  kolu-claude-code. */
const WAL_DEBOUNCE_MS = 150;

/** Tail window for reading the rollout JSONL. Matches kolu-claude-code's
 *  TAIL_BYTES — sized to comfortably contain the last few turns
 *  (task_started → agent_message → task_complete plus any tool calls).
 *  Codex rollout lines are smaller than Claude's (assistant content is
 *  split into many `response_item` records rather than one monolithic
 *  `assistant` entry), so 256 KB is generous. */
const TAIL_BYTES = 256 * 1024;

// --- Watcher ---

export interface CodexWatcher extends AgentWatcher {
  readonly session: CodexSession;
}

/**
 * Start watching a Codex session. Reads current state immediately and
 * emits an initial CodexInfo, then re-reads on every watch event
 * (debounced) and emits a new info if it differs from the last one.
 *
 * `onChange` is called with the full CodexInfo each time state changes.
 * The caller forwards it to the metadata system.
 */
export function createCodexWatcher(
  session: CodexSession,
  executor: Executor,
  onChange: (info: CodexInfo) => void,
  log?: Logger,
): CodexWatcher {
  let last: CodexInfo | null = null;
  let stopped = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let walHandle: { stop(): void } | null = null;
  let rolloutHandle: { stop(): void } | null = null;
  /** Set while a `refresh` is in flight. A second `scheduleRefresh` that
   *  fires during the in-flight run sets `pending` so we re-run once the
   *  current call resolves — without this, an event that lands between
   *  the in-flight check and the work completing would be silently
   *  dropped. */
  let pending = false;
  let inFlight = false;
  /** Cache of the last-parsed rollout state + context-token count,
   *  scoped to the rollout JSONL's mtime. On a watch event whose
   *  rollout-file mtime matches the cached value, we reuse the parsed
   *  values instead of re-reading and re-parsing the tail.
   *
   *  This is the hot-path optimization: DB-only WAL events (e.g. title
   *  updates, row touches) don't append to the rollout, so `state` and
   *  `contextTokens` can't have changed. Without the short-circuit,
   *  we'd re-read + re-parse 256 KB on every such fire. */
  let cachedMtime: number | null = null;
  let cachedDerive: {
    state: CodexInfo["state"];
    contextTokens: number | null;
  } | null = null;

  async function refresh(): Promise<void> {
    if (stopped) return;
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      const meta = await getThreadMetadata(
        session.id,
        session.dbPath,
        executor,
        log,
      );
      if (stopped) return;
      if (!meta) {
        // The row existed at match time (otherwise we wouldn't have a
        // CodexSession at all) — a null here means Codex deleted it
        // after we subscribed. That's a real anomaly, not a race
        // window, so it warrants `warn`, not `debug`.
        log?.warn(
          { session: session.id },
          "codex thread row disappeared after match",
        );
        return;
      }

      let state: CodexInfo["state"];
      let contextTokens: number | null;
      let mtime: number | null = null;
      try {
        mtime = await executor.statMtimeMs(session.rolloutPath);
      } catch (err) {
        // statMtimeMs rejects on missing files too — at debug level
        // because the rollout legitimately can't exist before Codex's
        // first JSONL write lands.
        log?.debug(
          { err, path: session.rolloutPath },
          "codex rollout stat failed",
        );
      }
      if (stopped) return;
      if (mtime !== null && cachedMtime === mtime && cachedDerive) {
        state = cachedDerive.state;
        contextTokens = cachedDerive.contextTokens;
      } else {
        const lines = await readRolloutTail(
          session.rolloutPath,
          TAIL_BYTES,
          executor,
          log,
        );
        if (stopped) return;
        if (lines === null) return;
        const parsedState = parseRolloutState(lines);
        if (parsedState === null) {
          log?.debug(
            { session: session.id, path: session.rolloutPath },
            "codex rollout has no task events yet",
          );
          return;
        }
        state = parsedState;
        contextTokens = parseRolloutContextTokens(lines);
        if (mtime !== null) {
          cachedMtime = mtime;
          cachedDerive = { state, contextTokens };
        }
      }

      const info: CodexInfo = {
        kind: "codex",
        state,
        sessionId: session.id,
        model: meta.model,
        summary: meta.title,
        taskProgress: null,
        contextTokens,
      };
      if (agentInfoEqual(info, last)) return;
      last = info;
      log?.debug(
        {
          state: info.state,
          model: info.model,
          session: info.sessionId,
          tokens: info.contextTokens,
        },
        "codex state updated",
      );
      onChange(info);
    } catch (err) {
      log?.debug({ err, session: session.id }, "codex refresh failed");
    } finally {
      inFlight = false;
      if (pending && !stopped) {
        pending = false;
        // Defer one tick — running synchronously would let the
        // recursive call extend the current call's stack on burst
        // input.
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

  // Install both watches in the background — `executor.watch` is async
  // (the remote helper needs an RPC round-trip; local fs.watch is sync
  // but wrapped in a resolved Promise). We don't block the watcher's
  // construction on install, but we DO kick an initial `refresh` so
  // the badge populates without waiting for the first WAL event.
  void (async () => {
    try {
      walHandle = await executor.watch(
        `${session.dbPath}-wal`,
        () => scheduleRefresh(),
        { recursive: false },
      );
    } catch (err) {
      log?.debug(
        { err, walPath: `${session.dbPath}-wal` },
        "codex WAL watch install failed",
      );
    }
    try {
      rolloutHandle = await executor.watch(
        session.rolloutPath,
        () => scheduleRefresh(),
        { recursive: false },
      );
    } catch (err) {
      log?.debug(
        { err, path: session.rolloutPath },
        "codex rollout watch install failed",
      );
    }
    if (!stopped) void refresh();
  })();

  return {
    session,
    destroy: () => {
      stopped = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      walHandle?.stop();
      rolloutHandle?.stop();
      walHandle = null;
      rolloutHandle = null;
    },
  };
}
