/**
 * Shared WAL watcher for OpenCode's database. Wraps `kolu-shared`'s
 * `createWalSubscription` — the refcounted singleton, parent-dir
 * fallback, and promote-on-appearance dance all live upstream.
 *
 * The exported `subscribeOpenCodeDb` takes an `Executor` for contract
 * symmetry with the rest of the OpenCode integration (everything else
 * is executor-aware), but the underlying singleton currently only
 * implements the controller-local fs path — the upstream refactor of
 * kolu-shared's WAL subscription to route through an executor is out
 * of scope here. Remote backends fall back to the local path today;
 * that's a known limitation, not a silent fork.
 */

import type { Executor } from "kolu-io";
import type { Logger } from "kolu-shared";
import { createWalSubscription } from "kolu-shared/sqlite";
import { OPENCODE_DB_PATH, OPENCODE_DB_WAL_PATH } from "./config.ts";

const { subscribe: subscribeOpenCodeDbLocal } = createWalSubscription({
  dbPath: OPENCODE_DB_PATH,
  walPath: OPENCODE_DB_WAL_PATH,
  label: "opencode",
});

/** Subscribe to OpenCode WAL changes. `executor` is reserved for the
 *  forthcoming kolu-shared executor-aware refactor; today the call is
 *  routed through the local-fs singleton regardless of executor. */
export function subscribeOpenCodeDb(
  _executor: Executor,
  onChange: () => void,
  onError: (err: unknown) => void,
  log?: Logger,
): () => void {
  return subscribeOpenCodeDbLocal(onChange, onError, log);
}
