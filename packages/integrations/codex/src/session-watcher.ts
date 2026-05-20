/**
 * CodexWatcher — per-session lifecycle over the supplied executor.
 *
 * On each shared WAL event, re-read mutable SQLite metadata through the
 * executor, tail the rollout JSONL, and publish a changed CodexInfo snapshot.
 */

import { agentInfoEqual } from "anyagent";
import { readTailLines, statSizeBytes, type Executor } from "kolu-io";
import type { Logger } from "kolu-shared";
import { createDebounceWatcher } from "kolu-shared/sqlite";
import {
  type CodexSession,
  getThreadMetadata,
  parseRolloutContextTokens,
  parseRolloutState,
} from "./core.ts";
import type { CodexInfo } from "./schemas.ts";
import { subscribeCodexDb } from "./wal-watcher.ts";

const WAL_DEBOUNCE_MS = 150;
const TAIL_BYTES = 256 * 1024;

export interface CodexWatcher {
  readonly session: CodexSession;
  destroy(): void;
}

export function createCodexWatcher(
  session: CodexSession,
  executor: Executor,
  onChange: (info: CodexInfo) => void,
  log?: Logger,
): CodexWatcher {
  const watcherContext = { session, executor };
  let cachedDerive: {
    size: number;
    state: CodexInfo["state"];
    contextTokens: number | null;
  } | null = null;

  async function readInfo(
    ctx: typeof watcherContext,
  ): Promise<CodexInfo | null> {
    const meta = await getThreadMetadata(
      ctx.session.id,
      ctx.executor,
      ctx.session.dbPath,
      log,
    );
    if (!meta) {
      log?.warn(
        { session: ctx.session.id },
        "codex thread row disappeared after match",
      );
      return null;
    }

    const size = await statSizeBytes(
      ctx.executor,
      ctx.session.rolloutPath,
      log,
    );
    if (size === null) return null;

    let state: CodexInfo["state"];
    let contextTokens: number | null;
    if (cachedDerive !== null && cachedDerive.size === size) {
      state = cachedDerive.state;
      contextTokens = cachedDerive.contextTokens;
    } else {
      const lines = await readTailLines(
        ctx.executor,
        ctx.session.rolloutPath,
        TAIL_BYTES,
        log,
      );
      const parsedState = parseRolloutState(lines);
      if (parsedState === null) {
        log?.debug(
          { session: ctx.session.id, path: ctx.session.rolloutPath },
          "codex rollout has no task events yet",
        );
        return null;
      }
      state = parsedState;
      contextTokens = parseRolloutContextTokens(lines);
      cachedDerive = { size, state, contextTokens };
    }

    return {
      kind: "codex",
      state,
      sessionId: ctx.session.id,
      model: meta.model,
      summary: meta.title,
      taskProgress: null,
      contextTokens,
    };
  }

  return createDebounceWatcher({
    session,
    label: "codex: session",
    debounceMs: WAL_DEBOUNCE_MS,
    db: watcherContext,
    subscribe: (onEvent, onError, plog) =>
      subscribeCodexDb(
        executor,
        session.dbPath,
        session.walPath,
        onEvent,
        onError,
        plog,
      ),
    refresh: readInfo,
    isEqual: agentInfoEqual,
    onChange: (info) => {
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
    },
    logCtx: { session: session.id },
    log,
  });
}
