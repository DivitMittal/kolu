/**
 * Per-process temp root for process-generated files.
 *
 * Relocated to `kolu-shared/koluRoot` so the `kolu --stdio` PTY-host daemon
 * (`@kolu/pty-host`) — which spawns the shells now (#951 R4c) and so writes
 * their rc files — can share the same logic without importing kolu-server (a
 * package cycle). Re-exported here so existing server importers keep their
 * `./koluRoot.ts` import path unchanged.
 */
export {
  ensureKoluRoot,
  koluRoot,
  koluScratchDir,
  koluShellDir,
  shutdownCleanup,
} from "kolu-shared/koluRoot";
