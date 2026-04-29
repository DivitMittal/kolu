/**
 * Lifecycle log helpers for long-lived `fs.watch` (or analogous)
 * subscriptions. Centralizes the convention from PR #775 (the shared
 * `.git/HEAD` watcher) so the format `<label> watcher installed/retired`
 * lives in one place rather than being re-derived at each site.
 *
 * `label` names the specific watcher in operator log scans
 * (e.g. `"git: head"`, `"claude-code: transcript"`, `"codex: wal"`).
 */

import type { Logger } from "./schemas.ts";

export function logWatcherInstalled(
  log: Logger | undefined,
  label: string,
  fields: Record<string, unknown>,
): void {
  log?.info(fields, `${label} watcher installed`);
}

export function logWatcherRetired(
  log: Logger | undefined,
  label: string,
  fields: Record<string, unknown>,
): void {
  log?.info(fields, `${label} watcher retired`);
}
