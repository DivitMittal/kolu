/**
 * Refcounted shared git metadata watchers.
 *
 * `watchGitHead` catches branch identity changes (`git checkout`, `git
 * switch`, detached HEAD) by watching `.git/HEAD`. It does not catch commits on
 * the current branch; that axis lives in `watchGitReflog`.
 *
 * `watchGitMetadata` is the coarser stream used by `subscribeGitInfo`: it
 * watches HEAD plus repo/worktree config so branch and remote metadata both
 * re-resolve live.
 */

import type { Logger } from "kolu-shared";
import {
  resolveGitCommonDir,
  resolveGitDir,
  WATCHER_DEBOUNCE_MS,
} from "./git-dir.ts";
import { createDirFilenameWatcher } from "./shared-dir-filename-watcher.ts";

const headWatcher = createDirFilenameWatcher({
  resolveDir: resolveGitDir,
  filename: "HEAD",
  debounceMs: WATCHER_DEBOUNCE_MS,
  logLabel: "git: head",
});

const worktreeConfigWatcher = createDirFilenameWatcher({
  resolveDir: resolveGitDir,
  filename: "config.worktree",
  debounceMs: WATCHER_DEBOUNCE_MS,
  logLabel: "git: worktree-config",
});

const commonConfigWatcher = createDirFilenameWatcher({
  resolveDir: resolveGitCommonDir,
  filename: "config",
  debounceMs: WATCHER_DEBOUNCE_MS,
  logLabel: "git: common-config",
});

interface MetadataDirs {
  gitDir: string;
  commonGitDir: string;
}

interface SharedMetadataWatcher {
  subscribe(onChange: () => void): () => void;
}

const metadataWatchers = new Map<string, SharedMetadataWatcher>();

function resolveMetadataDirs(cwd: string): MetadataDirs | null {
  const gitDir = resolveGitDir(cwd);
  const commonGitDir = resolveGitCommonDir(cwd);
  return gitDir && commonGitDir ? { gitDir, commonGitDir } : null;
}

function metadataKey(dirs: MetadataDirs): string {
  return `${dirs.gitDir}\0${dirs.commonGitDir}`;
}

function metadataFields(dirs: MetadataDirs): Record<string, unknown> {
  return { gitDir: dirs.gitDir, commonGitDir: dirs.commonGitDir };
}

function installMetadataWatcher(
  cwd: string,
  dirs: MetadataDirs,
  onLast: () => void,
  log?: Logger,
): SharedMetadataWatcher {
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;

  function tick(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      for (const cb of [...listeners]) {
        try {
          cb();
        } catch (e) {
          log?.error(
            {
              err: e instanceof Error ? e.message : String(e),
              ...metadataFields(dirs),
            },
            "git: metadata listener threw",
          );
        }
      }
    }, WATCHER_DEBOUNCE_MS);
  }

  const upstreamUnsubs = [
    headWatcher.watch(cwd, tick, log),
    worktreeConfigWatcher.watch(cwd, tick, log),
    commonConfigWatcher.watch(cwd, tick, log),
  ];
  log?.info(metadataFields(dirs), "git: metadata watcher installed");

  return {
    subscribe(onChange) {
      listeners.add(onChange);
      return () => {
        if (!listeners.delete(onChange)) return;
        if (listeners.size === 0) {
          if (timer) clearTimeout(timer);
          for (const unsubscribe of upstreamUnsubs) unsubscribe();
          onLast();
          log?.info(metadataFields(dirs), "git: metadata watcher retired");
        }
      };
    },
  };
}

/** Watch `.git/HEAD` for branch identity changes. Returns a no-op for
 *  non-git directories. */
export const watchGitHead = headWatcher.watch;

/** Watch git metadata changes that affect `GitInfo` (branch switches, remote
 *  add/remove/set-url, worktree config changes, etc.). Returns a no-op for
 *  non-git directories. */
export function watchGitMetadata(
  cwd: string,
  onChange: () => void,
  log?: Logger,
): () => void {
  const dirs = resolveMetadataDirs(cwd);
  if (!dirs) return () => {};
  const key = metadataKey(dirs);
  let entry = metadataWatchers.get(key);
  if (!entry) {
    entry = installMetadataWatcher(
      cwd,
      dirs,
      () => metadataWatchers.delete(key),
      log,
    );
    metadataWatchers.set(key, entry);
  }
  return entry.subscribe(onChange);
}

export const _sharedHeadWatcherCount = headWatcher._watcherCount;

/** Test-only — number of distinct gitDir/commonGitDir metadata entries with
 *  active shared watchers. */
export function _sharedGitMetadataWatcherCount(): number {
  return metadataWatchers.size;
}
