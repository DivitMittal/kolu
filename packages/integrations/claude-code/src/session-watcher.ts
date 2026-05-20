/**
 * SessionWatcher — per-session lifecycle, fully push-driven over the
 * executor. Same body for local and remote terminals.
 *
 * Lifecycle:
 *   1. Find the transcript JSONL path
 *      (`<projectsDir>/<encoded-cwd>/<id>.jsonl`). If it doesn't exist
 *      yet (Claude creates it on the first user↔assistant exchange),
 *      watch the project dir until it appears.
 *   2. Once attached, watch the transcript via `executor.watch`.
 *      Debounce the bursts (Claude streams tokens; the file fires many
 *      writes per turn).
 *   3. On each debounced tick: tail the JSONL via
 *      `executor.exec("tail", ...)`, derive state + accumulate
 *      TaskUpdates, emit `ClaudeCodeInfo` if it differs from the last.
 *
 * No polling. Task accumulation walks the tail each tick — TaskCreate is
 * always emitted right before its TaskUpdates, so accumulation stays
 * correct in the typical run.
 *
 * Creating a SessionWatcher starts transcript watching, task scanning,
 * and summary fetching. Destroying it tears everything down. No
 * "remember to reset N variables" invariant — the lifetime IS the
 * object.
 */

import { type AgentWatcher, agentInfoEqual } from "anyagent";
import type { Executor } from "kolu-io";
import type { Logger } from "kolu-shared";
import {
  deriveState,
  deriveTaskProgress,
  encodeProjectPath,
  extractTasks,
  fetchSessionSummary,
  findTranscriptPath,
  type SessionFile,
  TAIL_BYTES,
  tailJsonlLines,
} from "./core.ts";
import type { ClaudeCodeInfo } from "./schemas.ts";

// --- Tuning constants ---

/** Trailing-edge debounce for the transcript watch callback. Claude
 *  streams tokens, and Linux fs.watch fires multiple events per write —
 *  without debouncing, the refresh loop runs dozens to hundreds of
 *  times per second, each iteration re-fetching a 256 KB tail and
 *  firing an async SDK summary fetch. 150 ms coalesces bursts into one
 *  handler run while keeping the user-perceptible lag imperceptible. */
const TRANSCRIPT_DEBOUNCE_MS = 150;

// --- Diagnostics counter ---

/** Count of in-flight `fetchSessionSummary` calls across all SessionWatchers.
 *  Exposed via `getPendingSummaryFetches` for the server's diagnostics log.
 *
 *  Maintained by a try/finally pair inside `refreshSummary` so every
 *  completion path (resolve, reject, new error branch added later) is
 *  structurally guaranteed to decrement. Don't turn refreshSummary back
 *  into a .then/.catch pair or the pairing breaks.
 *
 *  Climbing unboundedly = backpressure: fs.watch on the Claude transcript
 *  is firing faster than getSessionInfo can respond, which is the shape
 *  of the leak we're trying to diagnose. */
let pendingSummaryFetches = 0;
export const getPendingSummaryFetches = (): number => pendingSummaryFetches;

// --- SessionWatcher ---

export interface SessionWatcher extends AgentWatcher {
  readonly session: SessionFile;
}

/**
 * Create a SessionWatcher for a matched Claude Code session.
 *
 * Starts transcript watching, task accumulation, and summary fetching.
 * Calls `onUpdate` whenever the derived ClaudeCodeInfo changes
 * (change-gated via `agentInfoEqual`).
 *
 * Call `destroy()` to tear everything down.
 */
export function createSessionWatcher(
  session: SessionFile,
  executor: Executor,
  onUpdate: (info: ClaudeCodeInfo) => void,
  plog: Logger,
): SessionWatcher {
  let stopped = false;
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let transcriptHandle: { stop(): void } | null = null;
  let projectDirHandle: { stop(): void } | null = null;
  let transcriptPath: string | null = null;
  let lastInfo: ClaudeCodeInfo | null = null;
  let lastSummary: string | null = null;
  const taskMap = new Map<string, "pending" | "in_progress" | "completed">();
  // Reentrancy guard: `refresh` is async (it awaits `tailJsonlLines`).
  // If a second debounce tick lands while one is already running, we
  // mark `pending` and let the in-flight one re-trigger after it
  // completes. Without this, two concurrent tail+derive runs can
  // interleave their `onUpdate` calls and emit stale info after fresh.
  let inFlight = false;
  let pending = false;

  /** Trailing-edge debounce: reset the timer on every event, fire
   *  `refresh` once after `TRANSCRIPT_DEBOUNCE_MS` of quiet. The
   *  handler's own `stopped` guard makes late-firing callbacks safe,
   *  but we clear the timer in `destroy()` anyway to avoid holding
   *  closure refs unnecessarily. */
  function scheduleRefresh(): void {
    if (stopped) return;
    if (debounceTimer !== undefined) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = undefined;
      void refresh();
    }, TRANSCRIPT_DEBOUNCE_MS);
  }

  async function refresh(): Promise<void> {
    if (stopped || !transcriptPath) return;
    if (inFlight) {
      pending = true;
      return;
    }
    inFlight = true;
    try {
      const lines = await tailJsonlLines(
        transcriptPath,
        TAIL_BYTES,
        executor,
        plog,
      );
      if (stopped) return;
      const derived = deriveState(lines);
      if (!derived) {
        plog.debug(
          { path: transcriptPath },
          "no user/assistant message in transcript tail",
        );
        return;
      }
      extractTasks(lines, taskMap, plog);
      const info: ClaudeCodeInfo = {
        kind: "claude-code",
        state: derived.state,
        sessionId: session.sessionId,
        model: derived.model,
        summary: lastSummary,
        taskProgress: deriveTaskProgress(taskMap),
        contextTokens: derived.contextTokens,
      };
      if (!agentInfoEqual(info, lastInfo)) {
        plog.debug(
          { state: info.state, model: info.model, session: info.sessionId },
          "claude code state updated",
        );
        lastInfo = info;
        onUpdate(info);
      }
      // Fire-and-forget: refreshSummary owns its try/catch/finally and
      // the pendingSummaryFetches counter. Not awaited so the caller
      // (transcript-change handler) doesn't block on the network fetch.
      void refreshSummary();
    } catch (err) {
      plog.error({ err, session: session.sessionId }, "claude refresh failed");
    } finally {
      inFlight = false;
      if (pending && !stopped) {
        pending = false;
        setTimeout(() => void refresh(), 0);
      }
    }
  }

  async function refreshSummary(): Promise<void> {
    if (stopped) return;
    pendingSummaryFetches++;
    try {
      const summary = await fetchSessionSummary(session.sessionId, session.cwd);
      if (stopped) return;
      if (summary === lastSummary) return;
      lastSummary = summary;
      if (!lastInfo) return;
      plog.debug(
        { summary, session: session.sessionId },
        "claude summary updated",
      );
      const updated: ClaudeCodeInfo = { ...lastInfo, summary };
      lastInfo = updated;
      onUpdate(updated);
    } catch (err) {
      plog.debug({ err, session: session.sessionId }, "getSessionInfo failed");
    } finally {
      pendingSummaryFetches--;
    }
  }

  async function attachToTranscript(p: string): Promise<void> {
    try {
      transcriptHandle = await executor.watch(p, () => scheduleRefresh(), {
        recursive: false,
      });
      transcriptPath = p;
      plog.info(
        { path: p, session: session.sessionId },
        "claude-code: transcript watcher installed",
      );
      void refresh();
    } catch (err) {
      plog.error({ err, path: p }, "failed to watch transcript");
    }
  }

  async function tryFindAndAttach(): Promise<boolean> {
    const tp = await findTranscriptPath(session, executor);
    if (!tp || stopped) return false;
    plog.debug({ path: tp }, "transcript found");
    await attachToTranscript(tp);
    return true;
  }

  // Bootstrap. Claude creates the JSONL lazily on the first user↔
  // assistant exchange, so a brand-new session has no transcript yet —
  // fall back to watching the project dir and re-trying once a file
  // appears. `executor.watch` subsumes the old `tryWatchDir` /
  // `watchOrWaitForDir` retry-wait dance: a single watch on the
  // project dir, no parent-dir fallback needed (the project dir is
  // created lazily but `executor.watch` would have failed silently
  // anyway, so we proactively fall back through the try/catch).
  void (async () => {
    if (await tryFindAndAttach()) return;
    plog.debug(
      { session: session.sessionId, cwd: session.cwd },
      "transcript not found yet (JSONL created after first message); waiting on project dir",
    );
    const projectDir = `${session.projectsDir}/${encodeProjectPath(session.cwd)}`;
    try {
      projectDirHandle = await executor.watch(
        projectDir,
        () => {
          if (stopped || transcriptPath) return;
          void (async () => {
            const ok = await tryFindAndAttach();
            if (ok && projectDirHandle) {
              projectDirHandle.stop();
              projectDirHandle = null;
            }
          })();
        },
        { recursive: false },
      );
    } catch (err) {
      plog.debug({ err, projectDir }, "project dir watch failed");
    }
  })();

  return {
    session,
    destroy(): void {
      stopped = true;
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
        debounceTimer = undefined;
      }
      if (transcriptHandle) {
        plog.info(
          { path: transcriptPath, session: session.sessionId },
          "claude-code: transcript watcher retired",
        );
        transcriptHandle.stop();
        transcriptHandle = null;
      }
      projectDirHandle?.stop();
      projectDirHandle = null;
    },
  };
}
