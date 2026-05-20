import type { Logger } from "kolu-shared";
import type { Executor } from "./executor.ts";

/** Resolve the executor's home directory through its command transport. */
export async function executorHomeDir(
  executor: Executor,
  log?: Logger,
): Promise<string | null> {
  try {
    const result = await executor.exec("printenv", ["HOME"], {
      timeoutMs: 5_000,
      maxBytes: 4096,
    });
    if (result.exitCode !== 0) {
      log?.error(
        { stderr: result.stderr, executor: executor.id },
        "executor HOME lookup failed",
      );
      return null;
    }
    const home = result.stdout.trim();
    if (!home) {
      log?.error({ executor: executor.id }, "executor HOME lookup was empty");
      return null;
    }
    return home;
  } catch (err) {
    log?.error({ err, executor: executor.id }, "executor HOME lookup threw");
    return null;
  }
}
