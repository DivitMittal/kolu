/**
 * Shared WAL watcher for Codex's threads DB. Wraps anyagent's
 * `createWalSubscription` — the refcounted singleton, parent-dir
 * fallback, and promote-on-appearance dance all live upstream.
 *
 * Executor-aware: the function takes an `Executor` so the contract
 * matches the agent-provider's `externalChanges.install` shape, but
 * today only the local executor's filesystem is wired through
 * `createWalSubscription` (a `kolu-shared/sqlite` helper that uses
 * node's `fs.watch` directly). When/if a remote executor needs this
 * external-change channel, the dispatch will branch here on executor
 * identity. Until then, calling with any other executor returns a
 * no-op subscription rather than attempting `fs.watch` on a path that
 * lives on another host.
 */

import type { Executor } from "kolu-io";
import { localExecutor } from "kolu-io";
import type { Logger } from "kolu-shared";
import { createWalSubscription } from "kolu-shared/sqlite";
import { CODEX_DB_PATH, CODEX_DB_WAL_PATH } from "./config.ts";

const { subscribe: subscribeLocalCodexDb } = createWalSubscription({
  dbPath: CODEX_DB_PATH,
  walPath: CODEX_DB_WAL_PATH,
  label: "codex",
});

/** Subscribe to Codex's WAL writes against the given executor. The
 *  returned unsubscribe tears the listener back out of the refcounted
 *  singleton; the singleton itself stays installed for any other
 *  listeners. */
export function subscribeCodexDb(
  executor: Executor,
  onChange: () => void,
  onError: (err: unknown) => void,
  log?: Logger,
): () => void {
  if (executor === localExecutor) {
    return subscribeLocalCodexDb(onChange, onError, log);
  }
  // Non-local executor — the controller's fs.watch can't observe the
  // remote machine's WAL. Returning a no-op preserves the
  // `externalChanges.install` contract (a stoppable handle) without
  // pretending to watch.
  log?.debug(
    {},
    "codex: subscribeCodexDb called with non-local executor — no-op",
  );
  return () => {};
}
