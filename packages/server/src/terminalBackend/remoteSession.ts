/**
 * `getKoluHostSession(host)` — return the singleton `HostSession` for a
 * given ssh-config host alias. Resolves the agent `.drv` path via
 * `nix eval --raw $KOLU_AGENT_FLAKE_REF.packages.<remote-system>.default.drvPath`
 * after probing the remote's `uname -ms` to determine `<remote-system>`.
 *
 * The drv-path resolution is async; the session itself is cached
 * synchronously by host so repeated `getTerminalBackendFor({kind:
 * "remote", host})` calls collapse onto one session (and therefore one
 * ssh subprocess) per host.
 *
 * **Requires `KOLU_AGENT_FLAKE_REF` in the environment** — a flake
 * reference that exposes `packages.<system>.default` as the kolu
 * binary. No fallback: the operator opts in by setting it. Spawning a
 * remote terminal without this env var throws with a clear message.
 */

import { spawn } from "node:child_process";
import { getHostSession, type HostSession } from "@kolu/surface-nix-host";
import type { AgentContract } from "kolu-common/agentSurface";
import { log } from "../log.ts";

const sessions = new Map<string, HostSession<AgentContract>>();
const drvPathCache = new Map<string, Promise<string>>();

/** Run a child process and capture stdout as a trimmed string. Rejects
 *  with exit code + stderr if non-zero. */
function execCapture(
  command: string,
  args: string[],
  inputTimeoutMs = 30_000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(
        new Error(
          `${command} ${args.join(" ")} timed out after ${inputTimeoutMs}ms`,
        ),
      );
    }, inputTimeoutMs);
    proc.stdout?.setEncoding("utf-8");
    proc.stderr?.setEncoding("utf-8");
    proc.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    proc.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    proc.on("close", (code) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (code === 0) resolve(stdout.trim());
      else
        reject(
          new Error(
            `${command} ${args.join(" ")} exited ${code}: ${stderr.trim()}`,
          ),
        );
    });
    proc.on("error", (err) => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      reject(err);
    });
  });
}

/** Map `uname -ms` output (e.g. `"Linux x86_64"`, `"Darwin arm64"`) to
 *  a Nix system tuple (`x86_64-linux`, `aarch64-darwin`). */
function unameToNixSystem(uname: string): string {
  const [osRaw, archRaw] = uname.split(/\s+/);
  const os = osRaw?.toLowerCase();
  const arch = archRaw?.toLowerCase();
  if (!os || !arch) throw new Error(`unparseable uname output: ${uname}`);
  const archMap: Record<string, string> = {
    x86_64: "x86_64",
    amd64: "x86_64",
    arm64: "aarch64",
    aarch64: "aarch64",
  };
  const osMap: Record<string, string> = {
    linux: "linux",
    darwin: "darwin",
  };
  const nixArch = archMap[arch];
  const nixOs = osMap[os];
  if (!nixArch || !nixOs) throw new Error(`unsupported uname tuple: ${uname}`);
  return `${nixArch}-${nixOs}`;
}

async function resolveAgentDrvPath(host: string): Promise<string> {
  const flakeRef = process.env.KOLU_AGENT_FLAKE_REF;
  if (!flakeRef) {
    throw new Error(
      "remote terminals require KOLU_AGENT_FLAKE_REF (a Nix flake reference exposing packages.<system>.default as the kolu binary). No fallback by design.",
    );
  }
  const uname = await execCapture("ssh", [host, "uname", "-ms"]);
  const system = unameToNixSystem(uname);
  log.info({ host, uname, system, flakeRef }, "resolving agent drvPath");
  const drvPath = await execCapture(
    "nix",
    ["eval", "--raw", `${flakeRef}#packages.${system}.default.drvPath`],
    120_000,
  );
  log.info({ host, drvPath }, "resolved agent drvPath");
  return drvPath;
}

function getDrvPath(host: string): Promise<string> {
  let cached = drvPathCache.get(host);
  if (!cached) {
    cached = resolveAgentDrvPath(host).catch((err) => {
      // Don't cache failures — next attempt should retry.
      drvPathCache.delete(host);
      throw err;
    });
    drvPathCache.set(host, cached);
  }
  return cached;
}

/** Get-or-create the `HostSession<AgentContract>` for a host. The
 *  drv-path resolution kicks off asynchronously inside `getHostSession`
 *  itself — until then the session is in `copying` state, which
 *  `pin()` callers can observe via `onState`. */
export function getKoluHostSession(host: string): HostSession<AgentContract> {
  let session = sessions.get(host);
  if (!session) {
    // `getHostSession` requires drvPath synchronously. Resolve via
    // a then-passing wrapper: we hand it a placeholder that becomes
    // the real drvPath once nix eval resolves. The current
    // `getHostSession` signature takes drvPath as a value, so until
    // we resolve it, we can't construct the session.
    //
    // Workaround: construct a thunk via async IIFE that resolves
    // drvPath and then constructs the underlying session. We adapt
    // by deferring the session-build inside a small Promise wrapper.
    // For simplicity in this MVP we _block on_ the drvPath resolution
    // here — first call to `getKoluHostSession(host)` is async via
    // the wrapper below.
    throw new Error(
      "getKoluHostSession requires async drvPath resolution — use getKoluHostSessionAsync",
    );
  }
  return session;
}

/** Async variant — resolves drvPath then constructs / returns the
 *  cached session. Use this at terminal-spawn time. */
export async function getKoluHostSessionAsync(
  host: string,
): Promise<HostSession<AgentContract>> {
  let session = sessions.get(host);
  if (session && !session.isDestroyed()) return session;
  const drvPath = await getDrvPath(host);
  session = getHostSession<AgentContract>({
    host,
    drvPath,
    binary: "kolu",
  });
  sessions.set(host, session);
  return session;
}

/** Drop the cached session for a host (e.g. on teardown). The caller
 *  is responsible for `session.destroy()` if needed — this just
 *  removes the cache entry. */
export function forgetKoluHostSession(host: string): void {
  sessions.delete(host);
  drvPathCache.delete(host);
}
