/**
 * OpenCode core — pure functions and IO helpers for detecting OpenCode
 * sessions and deriving state from its SQLite database.
 *
 * Every side-effecting helper takes an `Executor` (from `kolu-io`) and
 * routes SQLite reads through `executor.queryDb`. The default
 * `localExecutor` wraps `node:sqlite` so local code paths and tests are
 * unchanged from before the refactor; remote backends implement the
 * same shape over RPC. One module, two backends.
 *
 * Architecture: OpenCode (TUI mode) is a single process that owns
 * `~/.local/share/opencode/opencode.db` directly via SQLite WAL mode.
 * The TUI does NOT expose an HTTP server by default — that's `opencode serve`.
 * So the only way to observe TUI sessions is to read the SQLite DB directly.
 *
 * Read concurrency is safe because OpenCode uses WAL mode — readers don't
 * block writers and vice versa. We open the DB read-only.
 *
 * State derivation from the latest message in a session:
 *   - role: "user"                          → "thinking" (waiting for assistant)
 *   - role: "assistant", no time.completed  → "thinking" (in flight)
 *   - role: "assistant", finish: "stop"     → "waiting"  (assistant finished)
 *   - role: "assistant", finish: other      → "thinking" (still working)
 *
 * Structure note: this file holds the leaf module. Peers `session-watcher.ts`,
 * `wal-watcher.ts`, and `agent-provider.ts` import from here; `index.ts` is
 * a pure barrel re-exporting from all of them plus `schemas.ts` / `config.ts`.
 */

import { DatabaseSync } from "node:sqlite";
import { classifyByAwaiting } from "anyagent";
import type { Executor } from "kolu-io";
import type { Logger } from "kolu-shared";
import { match } from "ts-pattern";
import { OPENCODE_DB_PATH, resolveOpenCodeDirs } from "./config.ts";
import type { OpenCodeInfo, TaskProgress } from "./schemas.ts";

// --- SQL constants ---
//
// Hoisted to module scope so callers (and tests) can share the exact same
// strings the production helpers run — no risk of a subtle WHERE-clause
// drift between local and remote backends.

/** SQL: most recently updated unarchived session for a directory. */
export const SESSION_BY_DIRECTORY_SQL =
  "SELECT id, title, directory FROM session WHERE directory = ? AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 1";

/** SQL: session title by id. */
export const SESSION_TITLE_SQL = "SELECT title FROM session WHERE id = ?";

/** SQL: latest message blob for a session — feeds `parseMessageState`. */
export const LATEST_MESSAGE_SQL =
  "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1";

/** SQL: latest *assistant* message blob — context-tokens lives on
 *  assistant turns only, so we can't reuse LATEST_MESSAGE_SQL. */
export const LATEST_ASSISTANT_MESSAGE_SQL =
  "SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC LIMIT 1";

/** SQL: todo aggregate counts for a session. */
export const TASK_PROGRESS_SQL =
  "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed FROM todo WHERE session_id = ?";

/** OpenCode built-in tools whose pending invocation means the agent is
 *  awaiting the human. Both call `Question.Service.ask` and write a
 *  `part` row with `state.status = "running"` while blocking on the
 *  user's reply (upstream verification:
 *  `packages/opencode/src/tool/question.ts:24` and
 *  `packages/opencode/src/tool/plan.ts:29`). Other interactive flows
 *  (`ctx.ask` permission prompts inside `shell`/`edit`/`write`/etc.)
 *  don't surface a distinct `tool` value — the part stays `shell`/etc.
 *  and is indistinguishable from a real-work tool. */
const AWAITING_USER_TOOLS = ["question", "plan_exit"] as const;

/** SQL: total + awaiting-user counts among the running tool parts of one
 *  message. SQLite's parameter binding doesn't accept arrays for
 *  `IN (...)`, so the placeholder list is built inline from a constant
 *  — safe because every value is a hard-coded literal, not user input. */
export const RUNNING_TOOLS_SQL = (() => {
  const placeholders = AWAITING_USER_TOOLS.map(() => "?").join(", ");
  return `SELECT COUNT(*) AS total, SUM(CASE WHEN json_extract(data, '$.tool') IN (${placeholders}) THEN 1 ELSE 0 END) AS awaiting FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.state.status') = 'running'`;
})();

// --- queryDb helper ---

/** Run a queryDb against an executor; surface absent support (executors
 *  without sqlite, e.g. a minimal RPC backend) and per-call failures as
 *  a clean log + null so callers don't need their own try/catch. */
async function runQuery(
  executor: Executor,
  path: string,
  sql: string,
  params: ReadonlyArray<string | number | null>,
  errorMsg: string,
  errorCtx: Record<string, unknown>,
  log: Logger | undefined,
): Promise<Array<Record<string, unknown>> | null> {
  if (!executor.queryDb) {
    log?.debug(errorCtx, "executor lacks queryDb support");
    return null;
  }
  try {
    return await executor.queryDb(path, sql, params);
  } catch (err) {
    log?.debug({ err, ...errorCtx }, errorMsg);
    return null;
  }
}

// --- Local DB open (transcript exporter only) ---

/**
 * Open a read-only connection to OpenCode's database on the *controller's*
 * local filesystem. Used exclusively by the one-shot HTML transcript
 * exporter (`transcript.ts`), which currently has no executor-aware
 * counterpart. The live agent-detection path goes through the executor.
 *
 * Caller MUST close the returned database when done.
 */
export function openDb(log?: Logger): DatabaseSync | null {
  try {
    return new DatabaseSync(OPENCODE_DB_PATH, { readOnly: true });
  } catch (err) {
    log?.debug({ err, path: OPENCODE_DB_PATH }, "opencode db unavailable");
    return null;
  }
}

// --- Database session lookup ---

export interface OpenCodeSession {
  id: string;
  title: string | null;
  directory: string;
  /** The resolved DB path used to find this session. Cached on the
   *  session so the per-session watcher doesn't re-run `printenv HOME`
   *  on every WAL tick. */
  dbPath: string;
}

/**
 * Find the most recently updated session for a given directory.
 * Returns null if no sessions exist for that directory or the DB is absent.
 *
 * Heuristic: pick the session with the largest `time_updated` — the one
 * the user most recently interacted with. If multiple sessions share a
 * directory, this picks the active one in practice.
 */
export async function findSessionByDirectory(
  directory: string,
  executor: Executor,
  log?: Logger,
): Promise<OpenCodeSession | null> {
  const dirs = await resolveOpenCodeDirs(executor, log);
  if (!dirs) return null;
  const rows = await runQuery(
    executor,
    dirs.dbPath,
    SESSION_BY_DIRECTORY_SQL,
    [directory],
    "opencode session query failed",
    { directory },
    log,
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0] as { id: string; title: string; directory: string };
  return {
    id: row.id,
    title: row.title || null,
    directory: row.directory,
    dbPath: dirs.dbPath,
  };
}

// --- Session title refresh ---

/** Re-read the current session title from the DB. Returns null if absent. */
export async function getSessionTitle(
  sessionId: string,
  dbPath: string,
  executor: Executor,
  log?: Logger,
): Promise<string | null> {
  const rows = await runQuery(
    executor,
    dbPath,
    SESSION_TITLE_SQL,
    [sessionId],
    "opencode session title query failed",
    { sessionId },
    log,
  );
  if (!rows || rows.length === 0) return null;
  return (rows[0] as { title: string }).title || null;
}

// --- Todo progress ---

/**
 * Read todo progress for a session from the `todo` table.
 * Returns null if the session has no todos.
 */
export async function getSessionTaskProgress(
  sessionId: string,
  dbPath: string,
  executor: Executor,
  log?: Logger,
): Promise<TaskProgress | null> {
  const rows = await runQuery(
    executor,
    dbPath,
    TASK_PROGRESS_SQL,
    [sessionId],
    "opencode todo query failed",
    { sessionId },
    log,
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0] as { total: number; completed: number | null };
  if (row.total === 0) return null;
  return { total: row.total, completed: row.completed ?? 0 };
}

// --- Context-token lookup ---

/**
 * Read the latest assistant message's running context-token total from
 * `tokens.total`. Independent of `deriveSessionState` because the signals
 * terminate differently: state pivots on the newest message of any role,
 * but the token total only lives on assistant messages — using the single
 * latest message would blank the count whenever the user's prompt is the
 * newest row (Thinking state).
 *
 * One indexed query against (session_id, time_created). `json_extract`
 * forces per-row blob inspection, but the walker stops at the first match
 * — in practice 1–3 rows.
 */
export async function getLatestAssistantContextTokens(
  sessionId: string,
  dbPath: string,
  executor: Executor,
  log?: Logger,
): Promise<number | null> {
  const rows = await runQuery(
    executor,
    dbPath,
    LATEST_ASSISTANT_MESSAGE_SQL,
    [sessionId],
    "opencode context-tokens query failed",
    { sessionId },
    log,
  );
  if (!rows || rows.length === 0) return null;
  const raw = (rows[0] as { data: string }).data;
  let parsed: MessageData;
  try {
    parsed = JSON.parse(raw) as MessageData;
  } catch (err) {
    // OpenCode writes this JSON itself, so a parse failure is a real
    // anomaly — surface it rather than silently blanking the badge.
    log?.error(
      { err, sessionId },
      "opencode assistant message.data parse failed",
    );
    return null;
  }
  return parsed.tokens?.total ?? null;
}

// --- Tool detection ---

/** Classify the tool parts currently in the "running" state for one
 *  message (the current assistant turn) — scoped per-message rather
 *  than per-session so a transcript with thousands of completed tool
 *  parts stays cheap to scan.
 *
 *  Returns `null` when no tools are running (the caller keeps its base
 *  state), `"tool_use"` when at least one real-work tool is in flight,
 *  and `"awaiting_user"` when every running part is in
 *  `AWAITING_USER_TOOLS`. One SQL pass counts total + awaiting using
 *  the `part_message_id_id_idx` index. */
export async function runningToolsBucket(
  messageId: string,
  dbPath: string,
  executor: Executor,
  log?: Logger,
): Promise<"tool_use" | "awaiting_user" | null> {
  const rows = await runQuery(
    executor,
    dbPath,
    RUNNING_TOOLS_SQL,
    [...AWAITING_USER_TOOLS, messageId],
    "opencode running-tools query failed",
    { messageId },
    log,
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0] as { total: number; awaiting: number | null };
  if (row.total === 0) return null;
  return classifyByAwaiting(row.awaiting ?? 0, row.total);
}

// --- State derivation ---

/** Shape of the JSON in `message.data`. Only the fields we read. */
interface MessageData {
  role?: "user" | "assistant";
  modelID?: string;
  providerID?: string;
  finish?: string;
  time?: { created?: number; completed?: number };
  /** Present on assistant messages once OpenCode has accounted the turn.
   *  `total` is the running session token count, pre-summed by the
   *  provider — we just pass it through. */
  tokens?: { total?: number };
}

/** State derived from message JSON content only. Token telemetry is a
 *  separate signal (see `getLatestAssistantContextTokens`) because the
 *  latest-message lens this function provides doesn't match the
 *  latest-assistant-message lens that context accounting needs. */
export type ParsedMessageState = {
  state: OpenCodeInfo["state"];
  model: string | null;
};

/** Full derived state including the message ID for scoping
 *  downstream queries (e.g. tool-part lookup) to the current turn. */
export type DerivedState = ParsedMessageState & {
  messageId: string;
};

/**
 * Read the latest message for a session and derive Kolu state from it.
 * Returns null if the session has no messages or the DB is absent.
 */
export async function deriveSessionState(
  sessionId: string,
  dbPath: string,
  executor: Executor,
  log?: Logger,
): Promise<DerivedState | null> {
  const rows = await runQuery(
    executor,
    dbPath,
    LATEST_MESSAGE_SQL,
    [sessionId],
    "opencode message query failed",
    { sessionId },
    log,
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0] as { id: string; data: string };
  const parsed = parseMessageState(row.data);
  if (!parsed) return null;
  return { ...parsed, messageId: row.id };
}

/** Parse a `message.data` JSON blob into derived state.
 *  Exported for unit testing. */
export function parseMessageState(data: string): ParsedMessageState | null {
  let parsed: MessageData;
  try {
    parsed = JSON.parse(data) as MessageData;
  } catch {
    return null;
  }

  return match(parsed)
    .with({ role: "user" }, () => ({
      state: "thinking" as const,
      model: null,
    }))
    .with({ role: "assistant" }, (m) => {
      const model = m.modelID
        ? m.providerID
          ? `${m.providerID}/${m.modelID}`
          : m.modelID
        : null;
      // Assistant message with completion timestamp + clean stop = waiting
      if (m.time?.completed && m.finish === "stop") {
        return { state: "waiting" as const, model };
      }
      // Otherwise still working (no completion yet, or non-stop finish
      // reason like "tool-calls"). The watcher upgrades "thinking" to
      // "tool_use" when hasRunningTools() finds active tool parts.
      return { state: "thinking" as const, model };
    })
    .otherwise(() => null);
}
