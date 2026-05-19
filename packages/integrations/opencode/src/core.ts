/**
 * OpenCode core — pure functions for detecting OpenCode sessions and
 * deriving state from its SQLite database.
 *
 * Every IO operation flows through an `Executor` (`exec` / `readFile` /
 * `statMtimeMs` / `watch` / `queryDb`). The local kolu process passes
 * `localExecutor` from `kolu-git/executor`; remote terminals pass the
 * SSH host. Same code, two backends — no parallel "remote-opencode.ts"
 * shim, no DB-vs-RPC fork.
 *
 * Architecture: OpenCode (TUI mode) is a single process that owns
 * `~/.local/share/opencode/opencode.db` directly via SQLite WAL mode.
 * The TUI does NOT expose an HTTP server by default — that's `opencode
 * serve`. So the only way to observe TUI sessions is to read the SQLite
 * DB directly. Read concurrency is safe because OpenCode uses WAL mode
 * — readers don't block writers and vice versa.
 *
 * State derivation from the latest message in a session:
 *   - role: "user"                          → "thinking" (waiting for assistant)
 *   - role: "assistant", no time.completed  → "thinking" (in flight)
 *   - role: "assistant", finish: "stop"     → "waiting"  (assistant finished)
 *   - role: "assistant", finish: other      → "thinking" (still working)
 */

import { DatabaseSync } from "node:sqlite";
import type { Executor } from "anyagent";
import type { Logger } from "kolu-shared";
import { classifyByAwaiting } from "anyagent";
import { match } from "ts-pattern";
import { OPENCODE_DB_PATH } from "./config.ts";
import type { OpenCodeInfo, TaskProgress } from "./schemas.ts";

/** Open a read-only connection to OpenCode's database on the controller's
 *  local fs. Used by the one-shot HTML transcript exporter (`transcript.ts`),
 *  which runs only against the local DB — the live agent-detection path
 *  goes through the executor instead. */
export function openDb(log?: Logger): DatabaseSync | null {
  try {
    return new DatabaseSync(OPENCODE_DB_PATH, { readOnly: true });
  } catch (err) {
    log?.debug({ err, path: OPENCODE_DB_PATH }, "opencode db unavailable");
    return null;
  }
}

// --- SQL constants — exported so callers can audit / share ---

export const SESSION_BY_DIRECTORY_SQL =
  "SELECT id, title, directory FROM session WHERE directory = ? AND time_archived IS NULL ORDER BY time_updated DESC LIMIT 1";

export const SESSION_TITLE_SQL = "SELECT title FROM session WHERE id = ?";

export const LATEST_MESSAGE_SQL =
  "SELECT id, data FROM message WHERE session_id = ? ORDER BY time_created DESC LIMIT 1";

export const LATEST_ASSISTANT_MESSAGE_SQL =
  "SELECT data FROM message WHERE session_id = ? AND json_extract(data, '$.role') = 'assistant' ORDER BY time_created DESC LIMIT 1";

export const TASK_PROGRESS_SQL =
  "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed FROM todo WHERE session_id = ?";

/** OpenCode built-in tools whose pending invocation means the agent is
 *  awaiting the human. Both call `Question.Service.ask` and write a
 *  `part` row with `state.status = "running"` while blocking on the
 *  user's reply. */
const AWAITING_USER_TOOLS = ["question", "plan_exit"] as const;

export const RUNNING_TOOLS_SQL = (() => {
  // Inline placeholder list from a constant — safe because every value
  // is a hard-coded literal, not user input.
  const placeholders = AWAITING_USER_TOOLS.map(() => "?").join(", ");
  return `SELECT COUNT(*) AS total, SUM(CASE WHEN json_extract(data, '$.tool') IN (${placeholders}) THEN 1 ELSE 0 END) AS awaiting FROM part WHERE message_id = ? AND json_extract(data, '$.type') = 'tool' AND json_extract(data, '$.state.status') = 'running'`;
})();

// --- queryDb helper ---

/** Run a queryDb against an executor; surface the unsupported-op case
 *  (some executors may not implement queryDb) as a clean log + null. */
async function queryDb(
  executor: Executor,
  path: string,
  sql: string,
  params: ReadonlyArray<string | number | null>,
  log: Logger | undefined,
  errorCtx: Record<string, unknown>,
  errorMsg: string,
): Promise<Array<Record<string, unknown>> | null> {
  if (!executor.queryDb) {
    log?.debug({ ...errorCtx }, "executor lacks queryDb support");
    return null;
  }
  try {
    return await executor.queryDb(path, sql, params);
  } catch (err) {
    log?.debug({ err, ...errorCtx }, errorMsg);
    return null;
  }
}

// --- DB path resolution ---

/** Resolve the OpenCode DB path on this executor's filesystem.
 *  Local: `process.env.HOME/.local/share/opencode/opencode.db` (or the
 *  `KOLU_OPENCODE_DB` env override).
 *  Remote: `printenv HOME` on the helper, then append the rel path.
 *  Memoized per call; the caller typically caches it across refreshes. */
export async function resolveOpencodeDbPath(
  executor: Executor,
  log?: Logger,
): Promise<string | null> {
  // Local-side env override for testing — only applies if HOME resolves
  // to the controller's HOME (i.e. we're using localExecutor).
  if (process.env.KOLU_OPENCODE_DB) return process.env.KOLU_OPENCODE_DB;
  try {
    const r = await executor.exec("printenv", ["HOME"], { timeoutMs: 5_000 });
    if (r.exitCode !== 0) {
      log?.debug({ stderr: r.stderr }, "printenv HOME failed");
      return null;
    }
    const home = r.stdout.trim();
    if (!home) return null;
    return `${home}/.local/share/opencode/opencode.db`;
  } catch (err) {
    log?.debug({ err }, "resolveOpencodeDbPath failed");
    return null;
  }
}

// --- Database session lookup ---

export interface OpenCodeSession {
  id: string;
  title: string | null;
  directory: string;
  /** The resolved DB path used to find this session. Stashed here so the
   *  session-watcher doesn't have to re-resolve it on every refresh. */
  dbPath: string;
}

/**
 * Find the most recently updated session for a given directory.
 * Returns null if no sessions exist for that directory or the DB is absent.
 *
 * Heuristic: pick the session with the largest `time_updated` — the one
 * the user most recently interacted with.
 */
export async function findSessionByDirectory(
  directory: string,
  executor: Executor,
  log?: Logger,
): Promise<OpenCodeSession | null> {
  const dbPath = await resolveOpencodeDbPath(executor, log);
  if (!dbPath) return null;
  const rows = await queryDb(
    executor,
    dbPath,
    SESSION_BY_DIRECTORY_SQL,
    [directory],
    log,
    { directory },
    "opencode session query failed",
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0] as { id: string; title: string; directory: string };
  return {
    id: row.id,
    title: row.title || null,
    directory: row.directory,
    dbPath,
  };
}

// --- Session title refresh ---

export async function getSessionTitle(
  sessionId: string,
  dbPath: string,
  executor: Executor,
  log?: Logger,
): Promise<string | null> {
  const rows = await queryDb(
    executor,
    dbPath,
    SESSION_TITLE_SQL,
    [sessionId],
    log,
    { sessionId },
    "opencode session title query failed",
  );
  if (!rows || rows.length === 0) return null;
  return (rows[0] as { title: string }).title || null;
}

// --- Todo progress ---

export async function getSessionTaskProgress(
  sessionId: string,
  dbPath: string,
  executor: Executor,
  log?: Logger,
): Promise<TaskProgress | null> {
  const rows = await queryDb(
    executor,
    dbPath,
    TASK_PROGRESS_SQL,
    [sessionId],
    log,
    { sessionId },
    "opencode todo query failed",
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0] as { total: number; completed: number | null };
  if (row.total === 0) return null;
  return { total: row.total, completed: row.completed ?? 0 };
}

// --- Context-token lookup ---

export async function getLatestAssistantContextTokens(
  sessionId: string,
  dbPath: string,
  executor: Executor,
  log?: Logger,
): Promise<number | null> {
  const rows = await queryDb(
    executor,
    dbPath,
    LATEST_ASSISTANT_MESSAGE_SQL,
    [sessionId],
    log,
    { sessionId },
    "opencode context-tokens query failed",
  );
  if (!rows || rows.length === 0) return null;
  const raw = (rows[0] as { data: string }).data;
  let parsed: MessageData;
  try {
    parsed = JSON.parse(raw) as MessageData;
  } catch (err) {
    log?.error(
      { err, sessionId },
      "opencode assistant message.data parse failed",
    );
    return null;
  }
  return parsed.tokens?.total ?? null;
}

// --- Tool detection ---

export async function runningToolsBucket(
  messageId: string,
  dbPath: string,
  executor: Executor,
  log?: Logger,
): Promise<"tool_use" | "awaiting_user" | null> {
  const rows = await queryDb(
    executor,
    dbPath,
    RUNNING_TOOLS_SQL,
    [...AWAITING_USER_TOOLS, messageId],
    log,
    { messageId },
    "opencode running-tools query failed",
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
  tokens?: { total?: number };
}

export type ParsedMessageState = {
  state: OpenCodeInfo["state"];
  model: string | null;
};

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
  const rows = await queryDb(
    executor,
    dbPath,
    LATEST_MESSAGE_SQL,
    [sessionId],
    log,
    { sessionId },
    "opencode message query failed",
  );
  if (!rows || rows.length === 0) return null;
  const row = rows[0] as { id: string; data: string };
  const parsed = parseMessageState(row.data);
  if (!parsed) return null;
  return { ...parsed, messageId: row.id };
}

/** Parse a `message.data` JSON blob into derived state. Exported for unit
 *  testing — the same parsing logic feeds both local and remote paths. */
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
      if (m.time?.completed && m.finish === "stop") {
        return { state: "waiting" as const, model };
      }
      return { state: "thinking" as const, model };
    })
    .otherwise(() => null);
}
