/**
 * Refcounted shared `.git` entry watcher for directories that are not repos yet.
 *
 * `watchGitHead` can only install after a git dir exists. This watcher covers
 * the boundary case where a terminal is already sitting in a plain directory
 * and another process runs `git init` there.
 */

import fs from "node:fs";
import { WATCHER_DEBOUNCE_MS } from "./git-dir.ts";
import { createDirFilenameWatcher } from "./shared-dir-filename-watcher.ts";

const gitEntryWatcher = createDirFilenameWatcher({
  resolveDir: (cwd) => {
    try {
      return fs.realpathSync(cwd);
    } catch {
      return null;
    }
  },
  filename: ".git",
  debounceMs: WATCHER_DEBOUNCE_MS,
  logLabel: "git: entry",
});

export const watchGitEntry = gitEntryWatcher.watch;

/** Test-only inspector — number of directories with active `.git` entry watchers. */
export const _sharedGitEntryWatcherCount = gitEntryWatcher._watcherCount;
