/** The PTY-host daemon's own structured logger.
 *
 * The daemon is a SEPARATE process from kolu-server, so it constructs its own
 * pino logger rather than importing kolu-server's `log.ts` (which would be a
 * package cycle, and whose module-level state doesn't reach this process
 * anyway). It mirrors kolu-server's log shape — JSON in production, pretty in
 * dev, `LOG_LEVEL`-overridable, with a per-process id on every line — so the
 * `daemonMain.ts` call sites (`log.info({...}, "msg")`, `log.child(...)`,
 * `log.warn`, `log.error`) work identically.
 *
 * The socket is the wire, not stdout: the supervisor redirects the daemon's
 * stdout/stderr into `pty-host.log` (or the journal under systemd), so logging
 * to stdout is fine here — unlike a stdio agent, this daemon does NOT use
 * process.stdout as a protocol channel.
 */
import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import pino, { type Logger } from "pino";

const level = process.env.LOG_LEVEL ?? "info";
const base = {
  pid: process.pid,
  hostname: hostname(),
  daemonId: randomUUID(),
};

export const log = pino(
  process.env.NODE_ENV === "production"
    ? { level, base }
    : {
        level,
        base,
        transport: {
          target: "pino-pretty",
          options: { colorize: true, singleLine: true },
        },
      },
);

export type { Logger };
