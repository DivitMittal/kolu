/**
 * Startup probe for the coreutils + bash tools every `Executor.exec` call
 * site relies on. Every agent integration (claude-code, codex, opencode)
 * and kolu-git's worktree code shells out through the executor — when a
 * tool isn't on PATH the rejected `execFile` collapses into
 * `{ exitCode: null, stdout: "", stderr: "" }`, callers return null, and
 * **agent detection silently dies in production** even though tests pass
 * (e2e runs via `tsx` and inherits the dev-shell PATH).
 *
 * Probe runs once at boot, logs INFO on success and ERROR with the
 * missing-tool list on failure. The `ci/smoke.sh` runtime check greps for
 * the success line so a missing wrapper-PATH dependency fails CI before
 * users hit it.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Logger } from "./log.ts";

const execFileP = promisify(execFile);

/** Tools the controller-side `localExecutor` shells out to, by call site:
 *   - `printenv`: HOME lookup in resolveClaudeDirs / resolveCodexDir /
 *     resolveOpencodeDbPath.
 *   - `tail`: JSONL tail in tailJsonlLines (claude) and readRolloutTail
 *     (codex).
 *   - `sh`: `sh -c 'ls -1 …'` in resolveCodexDbPath's fallback enumeration.
 *   - `ls`: invoked inside the `sh -c` above; checked separately because
 *     `command -v sh` succeeding doesn't imply `ls` is reachable from the
 *     shell's PATH (busybox shells without coreutils, e.g.).
 *   - `readlink`: worktree path canonicalization. */
const REQUIRED_TOOLS = ["printenv", "tail", "sh", "ls", "readlink"] as const;

/** Probe each tool with a trivial invocation. `--version` is supported by
 *  GNU coreutils; on BSD it's `--help` or `-V`, both of which usually exit
 *  non-zero. Catching ENOENT directly via execFile's rejection is the
 *  reliable signal — we only care whether the binary is on PATH, not what
 *  it prints. */
async function isOnPath(tool: string): Promise<boolean> {
  try {
    await execFileP(tool, ["--version"], { timeout: 2_000 });
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT ⇒ not on PATH. Any other rejection (e.g. non-zero exit from
    // `sh --version` which sh doesn't accept) still means the binary was
    // found and ran — that's a PATH success.
    return code !== "ENOENT";
  }
}

export async function probeExecutorTools(log: Logger): Promise<void> {
  const results = await Promise.all(
    REQUIRED_TOOLS.map(async (t) => [t, await isOnPath(t)] as const),
  );
  const missing = results.filter(([, ok]) => !ok).map(([t]) => t);
  if (missing.length > 0) {
    log.error(
      { missing, path: process.env.PATH },
      "executor tools missing — agent detection will silently fail. " +
        "Add the missing tools (coreutils + bash) to the wrapper PATH.",
    );
    return;
  }
  log.info({ tools: REQUIRED_TOOLS }, "executor tools ready");
}
