/**
 * `Host` — an {@link Executor} that can also spawn PTYs and identify
 * itself. F4 of the remote-terminals feature will provide a `localHost`
 * and a `RemoteSshHost`; this file just declares the interface so the
 * orchestrator (and any other consumer) can program against it.
 */

import type { PtyHandle, SpawnPtyOpts } from "kolu-pty";
import type { Executor } from "./executor.ts";

/** Minimal structural Logger — matches kolu-shared's `Logger` shape.
 *  Inlined to keep kolu-io's `kolu-*` dependency surface small. */
export interface HostLogger {
  debug: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface Host extends Executor {
  /** Stable identifier — `"local"` for the controller, the SSH alias
   *  (or equivalent) for remote hosts. */
  readonly id: string;
  /** Human-readable label, e.g. shown in the dock SSH chip. */
  readonly label: string;
  readonly kind: "local" | "remote-ssh";
  spawnPty(
    log: HostLogger,
    terminalId: string,
    opts: SpawnPtyOpts,
    spawnCwd?: string,
  ): Promise<PtyHandle>;
  /** Release any resources (RPC connections, watcher handles, …) the
   *  host owns. Idempotent. */
  shutdown(): Promise<void>;
}
