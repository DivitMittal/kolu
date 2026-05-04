/**
 * Refcounted shared `.git` entry detector for directories that are not repos yet.
 *
 * `watchGitHead` can only install after a git dir exists. This detector covers
 * the boundary case where a terminal is already sitting in a plain directory
 * and another process runs `git init` there. It polls the one directory entry
 * instead of relying on a single create event, because the correctness
 * requirement here is level-triggered: if `.git` exists, re-resolve.
 */

import fs from "node:fs";
import path from "node:path";
import type { Logger } from "kolu-shared";

const GIT_ENTRY_POLL_MS = 500;

interface SharedGitEntryPoller {
  subscribe(onChange: () => void): () => void;
}

const pollers = new Map<string, SharedGitEntryPoller>();

function resolveDir(cwd: string): string | null {
  try {
    return fs.realpathSync(cwd);
  } catch {
    // The terminal cwd can be deleted before watcher installation; a null
    // target matches the other git watchers' no-op behavior for absent dirs.
    return null;
  }
}

function hasGitEntry(dir: string): boolean {
  try {
    fs.accessSync(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}

function install(
  dir: string,
  onLast: () => void,
  log?: Logger,
): SharedGitEntryPoller {
  const listeners = new Set<() => void>();
  let present = false;

  function notify(): void {
    const nextPresent = hasGitEntry(dir);
    if (!nextPresent) {
      present = false;
      return;
    }
    if (present) return;
    present = true;

    // Snapshot before iteration so a listener that unsubscribes synchronously
    // can't skip a peer for this event.
    for (const cb of [...listeners]) {
      try {
        cb();
      } catch (e) {
        log?.error(
          { err: e instanceof Error ? e.message : String(e), dir },
          "git: entry listener threw",
        );
      }
    }
  }

  const timer = setInterval(notify, GIT_ENTRY_POLL_MS);
  timer.unref?.();
  log?.info({ dir }, "git: entry watcher installed");

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      queueMicrotask(notify);
      return () => {
        // `Set.delete` returns false if `onChange` was already removed —
        // double-call from the same caller can't double-tear-down. A later
        // subscribe under the same dir installs a fresh singleton; this
        // closure stays bound to the old one.
        if (!listeners.delete(onChange)) return;
        if (listeners.size === 0) {
          clearInterval(timer);
          onLast();
          log?.info({ dir }, "git: entry watcher retired");
        }
      };
    },
  };
}

export function watchGitEntry(
  cwd: string,
  onChange: () => void,
  log?: Logger,
): () => void {
  const dir = resolveDir(cwd);
  if (dir === null) return () => {};
  let entry = pollers.get(dir);
  if (!entry) {
    entry = install(dir, () => pollers.delete(dir), log);
    pollers.set(dir, entry);
  }
  return entry.subscribe(onChange);
}

/** Test-only inspector — number of directories with active `.git` entry detectors. */
export const _sharedGitEntryWatcherCount = (): number => pollers.size;
