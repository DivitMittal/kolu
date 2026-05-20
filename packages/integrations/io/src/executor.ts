/**
 * `Executor` — the side-effecting IO primitives Kolu's higher-level
 * integration packages (kolu-git, the agent providers, etc.) need from
 * their environment.
 *
 * By taking these as a parameter (rather than reaching for `child_process`
 * / `fs` / `node:sqlite` directly), every operation that consumes an
 * `Executor` works unchanged against:
 *
 *   - the controller's local machine ({@link localExecutor}, the default
 *     when callers pass nothing), and
 *
 *   - any other host that satisfies this shape — e.g. a remote SSH host
 *     that routes the same primitives through an RPC helper. That's how
 *     Code-tab streams / branch chip / agent badges / etc. all light up
 *     for remote terminals without duplicating the integration code.
 *
 * One module, two backends.
 */

import { execFile } from "node:child_process";
import { watch as fsWatch } from "node:fs";
import { readFile as fsReadFile, stat as fsStat } from "node:fs/promises";
import { promisify } from "node:util";

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

export interface WatchHandle {
  stop(): void;
}

/** Side-effecting IO primitives. */
export interface Executor {
  /** Run a process and capture its output. */
  exec(
    cmd: string,
    args: string[],
    opts?: {
      cwd?: string;
      timeoutMs?: number;
      maxBytes?: number;
    },
  ): Promise<ExecResult>;
  /** Read a UTF-8 file with a maxBytes guard. */
  readFile(
    path: string,
    opts?: { maxBytes?: number },
  ): Promise<{ content: string; truncated: boolean }>;
  /** Return mtime in ms (also used as an existence probe — rejects if
   *  the path does not exist). */
  statMtimeMs(path: string): Promise<number>;
  /** Subscribe to filesystem change events for a path. */
  watch(
    path: string,
    onChange: (relPath: string) => void,
    opts?: { recursive?: boolean },
  ): Promise<WatchHandle>;
  /** Optional: query a SQLite database. Implementations that don't
   *  support SQLite leave this undefined; callers must feature-detect
   *  before using it. */
  queryDb?(
    path: string,
    sql: string,
    params?: ReadonlyArray<string | number | null>,
  ): Promise<Array<Record<string, unknown>>>;
}

const execFileP = promisify(execFile);

/** Default {@link Executor} — uses `child_process.execFile`, `fs.readFile`,
 *  `fs.stat`, `fs.watch`, and `node:sqlite` directly. Every consumer
 *  defaults to this when no explicit executor is passed, so local code
 *  paths and tests are unchanged from before the refactor. */
export const localExecutor: Executor = {
  exec: (cmd, args, opts) =>
    new Promise((resolve) => {
      execFileP(cmd, args, {
        cwd: opts?.cwd,
        timeout: opts?.timeoutMs ?? 30_000,
        maxBuffer: opts?.maxBytes ?? 128 * 1024 * 1024,
      })
        .then(({ stdout, stderr }) =>
          resolve({
            stdout: String(stdout ?? ""),
            stderr: String(stderr ?? ""),
            exitCode: 0,
          }),
        )
        .catch(
          (
            err: NodeJS.ErrnoException & {
              stdout?: unknown;
              stderr?: unknown;
              code?: number | string;
            },
          ) => {
            // execFile rejects on non-zero exit. Preserve stdout/stderr
            // and pass the exit code through as a number when possible —
            // git uses non-zero exits for "expected" outcomes (e.g.
            // `git diff --no-index` returns 1 when files differ).
            const exitCode = typeof err.code === "number" ? err.code : null;
            resolve({
              stdout: String(err.stdout ?? ""),
              stderr: String(err.stderr ?? ""),
              exitCode,
            });
          },
        );
    }),
  readFile: async (path, opts) => {
    const max = opts?.maxBytes ?? 1_048_576;
    const buf = await fsReadFile(path);
    if (buf.length > max) {
      return {
        content: buf.subarray(0, max).toString("utf-8"),
        truncated: true,
      };
    }
    return { content: buf.toString("utf-8"), truncated: false };
  },
  statMtimeMs: async (path) => {
    const s = await fsStat(path);
    return s.mtimeMs;
  },
  watch: (path, onChange, opts) => {
    const w = fsWatch(
      path,
      { recursive: opts?.recursive ?? false, persistent: true },
      (_eventType, filename) => onChange(filename ? filename.toString() : ""),
    );
    return Promise.resolve({
      stop: () => {
        try {
          w.close();
        } catch {
          // ignore
        }
      },
    });
  },
  queryDb: async (path, sql, params) => {
    // node:sqlite is built-in to Node ≥22 — dynamic import keeps the
    // dependency out of consumers that never call queryDb.
    const sqlite = await import("node:sqlite");
    const db = new sqlite.DatabaseSync(path, { readOnly: true });
    try {
      const stmt = db.prepare(sql);
      return stmt.all(...(params ?? [])) as Array<Record<string, unknown>>;
    } finally {
      db.close();
    }
  },
};
