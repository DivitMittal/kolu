/** Pino logger — JSON in production, pretty-printed in development.
 *
 * Default level is `info`. Override via `LOG_LEVEL` env var (e.g. `debug`,
 * `warn`, `trace`). The CLI's `--verbose` flag is a hard override applied
 * after construction in `index.ts` and trumps both.
 *
 * Every log line carries `serverId` (the randomUUID from `hostname.ts`) so
 * post-mortem log grepping can pin a line to a specific process run — the
 * diag dir name is `YYYYMMDDTHHMMSS-$$` but ties back to the serverId logged
 * at startup. */
import pino, { type Logger } from "pino";
import { serverHostname, serverProcessId } from "./hostname.ts";

const level = process.env.LOG_LEVEL ?? "info";
const base = {
  pid: process.pid,
  hostname: serverHostname,
  serverId: serverProcessId,
};

// In `kolu --stdio` (agent) mode, stdout is the oRPC channel — any
// non-protocol bytes there corrupt the framing and the client peer
// barfs `Unexpected token '«'` on the next message. Force ALL
// log output to stderr in that mode. Check process.argv directly so
// the redirect kicks in before any import-time log call fires.
const isAgentMode = process.argv.includes("--stdio");

export const log = pino(
  process.env.NODE_ENV === "production"
    ? { level, base }
    : {
        level,
        base,
        transport: {
          target: "pino-pretty",
          options: {
            colorize: true,
            singleLine: true,
            // pino-pretty supports `destination: <fd>` to redirect.
            // FD 2 = stderr. In agent mode we MUST use stderr.
            destination: isAgentMode ? 2 : 1,
          },
        },
      },
  // For production mode, also pipe to stderr in agent mode — pino
  // defaults to stdout, which would clobber the protocol channel.
  isAgentMode && process.env.NODE_ENV === "production"
    ? pino.destination(2)
    : undefined,
);

export type { Logger };
