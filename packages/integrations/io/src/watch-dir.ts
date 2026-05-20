import path from "node:path";
import type { Logger } from "kolu-shared";
import type { Executor, WatchHandle } from "./executor.ts";
import { isNotFoundError } from "./errors.ts";

/** Configuration for an executor-backed directory watcher with ancestor fallback. */
export interface WatchExistingDirConfig {
  executor: Executor;
  dir: string;
  label: string;
  logCtx?: Record<string, unknown>;
  debounceMs?: number;
  onChange: () => void;
  onError: (err: unknown) => void;
  log?: Logger;
}

type ActiveWatch = { target: string; handle: WatchHandle };

function parentOf(target: string): string | null {
  const parent = path.dirname(target);
  return parent === target ? null : parent;
}

async function nearestExistingAncestor(
  executor: Executor,
  dir: string,
  log?: Logger,
): Promise<string | null> {
  let target: string | null = dir;
  while (target) {
    try {
      await executor.statMtimeMs(target);
      return target;
    } catch (err) {
      if (!isNotFoundError(err)) {
        log?.error({ err, dir: target }, "directory ancestor stat failed");
        return null;
      }
      target = parentOf(target);
    }
  }
  return null;
}

/**
 * Watch `dir` when it exists; otherwise watch the nearest existing ancestor
 * and re-arm until `dir` appears.
 */
export async function watchExistingDirOrAncestor(
  config: WatchExistingDirConfig,
): Promise<WatchHandle> {
  const debounceMs = config.debounceMs ?? 150;
  let stopped = false;
  let active: ActiveWatch | null = null;
  let rearming = false;
  let debounceTimer: NodeJS.Timeout | null = null;

  function fields(target: string): Record<string, unknown> {
    return { ...config.logCtx, dir: config.dir, watchTarget: target };
  }

  function retireActive(): void {
    if (!active) return;
    const prev = active;
    active = null;
    prev.handle.stop();
    config.log?.info(fields(prev.target), `${config.label} watcher retired`);
  }

  function activate(target: string, handle: WatchHandle): void {
    const prev = active;
    active = { target, handle };
    if (prev) {
      prev.handle.stop();
      config.log?.info(fields(prev.target), `${config.label} watcher retired`);
    }
    config.log?.info(fields(target), `${config.label} watcher installed`);
  }

  function emitChange(): void {
    try {
      config.onChange();
    } catch (err) {
      config.onError(err);
    }
  }

  function scheduleChange(): void {
    if (stopped) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      emitChange();
    }, debounceMs);
  }

  async function tryWatchDir(): Promise<boolean> {
    try {
      const handle = await config.executor.watch(
        config.dir,
        () => scheduleChange(),
        { recursive: false },
      );
      if (stopped) {
        handle.stop();
        return true;
      }
      activate(config.dir, handle);
      scheduleChange();
      return true;
    } catch (err) {
      if (isNotFoundError(err)) return false;
      config.log?.error(
        { err, ...config.logCtx, dir: config.dir },
        `${config.label} watch failed`,
      );
      config.onError(err);
      return true;
    }
  }

  async function watchAncestor(): Promise<void> {
    const parent = parentOf(config.dir);
    const ancestor = parent
      ? await nearestExistingAncestor(config.executor, parent, config.log)
      : null;
    if (!ancestor) return;
    if (active?.target === ancestor) return;
    try {
      const handle = await config.executor.watch(ancestor, () => void rearm(), {
        recursive: false,
      });
      if (stopped) {
        handle.stop();
        return;
      }
      activate(ancestor, handle);
    } catch (err) {
      if (isNotFoundError(err)) return;
      config.log?.error(
        { err, ...config.logCtx, dir: config.dir, watchTarget: ancestor },
        `${config.label} ancestor watch failed`,
      );
      config.onError(err);
    }
  }

  async function rearm(): Promise<void> {
    if (stopped || rearming) return;
    rearming = true;
    try {
      if (await tryWatchDir()) return;
      await watchAncestor();
    } finally {
      rearming = false;
    }
  }

  await rearm();

  return {
    stop(): void {
      stopped = true;
      if (debounceTimer) {
        clearTimeout(debounceTimer);
        debounceTimer = null;
      }
      retireActive();
    },
  };
}
