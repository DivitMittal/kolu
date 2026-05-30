/**
 * Daemon-side paths under `$KOLU_STATE_DIR`.
 *
 * `daemonPaths` now lives in `kolu-shared/runtimePaths` so BOTH the PTY-host
 * daemon (`@kolu/pty-host`) and kolu-server's supervisor compute the same
 * socket/pid paths without a package cycle. It is re-exported here so existing
 * server-side importers (`./daemon/supervisor.ts`) keep their `../koluState.ts`
 * import path unchanged.
 *
 * Distinct from `./koluRoot.ts`, which is an *ephemeral* per-server-instance
 * tree (keyed by the server's startup UUID, under `$XDG_RUNTIME_DIR`) for
 * shell rc files + scratch. The daemon socket must instead live at a fixed
 * path so a *restarted* kolu-server finds the *same* running daemon.
 */
export { daemonPaths } from "kolu-shared/runtimePaths";
