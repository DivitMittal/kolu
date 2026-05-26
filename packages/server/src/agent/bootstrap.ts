/**
 * AgentBootstrap — installs `kolu-remote-agent` on a remote host on
 * first connect. Phase 2a of kolu#951.
 *
 * Mirrors Zed's `ensure_server_binary` at
 * `/tmp/zed/crates/remote/src/transport/ssh.rs:785-916`. Three install
 * strategies in order, first one that works wins:
 *
 *   1. **Already-installed** — `ssh host '<path> --version'` exits 0
 *      and reports the expected version. Skip install entirely.
 *   2. **Local upload via SFTP** — the kolu-server binary ships the
 *      compiled agent under `node_modules/kolu-remote-agent/dist/` (or
 *      `dist/agent/` in a packaged release). Bootstrap probes the
 *      remote's arch via `ssh host 'uname -sm'`, picks the matching
 *      bundle, transfers via SFTP, and verifies the version.
 *   3. **Remote download** — Phase 3 work; if a CDN URL is configured,
 *      the bootstrap returns it to the remote so curl fetches the
 *      binary in one round-trip. Not implemented in the prototype.
 *
 * The structure mirrors Zed even though the prototype only implements
 * strategy 1 fully — the others are stubs with `TODO:` markers that
 * Phase 2a's first-real-install PR fills in.
 */

import { spawn } from "node:child_process";
import type { Logger } from "kolu-shared";

const EXPECTED_AGENT_VERSION = "0.1.0";

/** Absolute path on the remote where the agent lives. Phase 2a
 *  conventions: `~/.local/share/kolu/remote-agent/<version>/index.js`.
 *  The version segment lets multiple kolu releases share a host. */
function remoteAgentPath(): string {
  return `$HOME/.local/share/kolu/remote-agent/${EXPECTED_AGENT_VERSION}/index.js`;
}

export interface AgentBootstrapResult {
  /** Absolute path the HostSession should invoke. */
  remoteAgentPath: string;
  /** Strategy that produced the install — useful for diagnostics. */
  strategy: "already-installed" | "uploaded" | "downloaded";
}

export async function ensureAgent(
  host: string,
  log: Logger,
): Promise<AgentBootstrapResult> {
  const path = remoteAgentPath();

  // Strategy 1: probe for an existing installation.
  if (await probeAgentVersion(host, path, log)) {
    log.info({ host, agentPath: path }, "agent already installed");
    return { remoteAgentPath: path, strategy: "already-installed" };
  }

  // Strategy 2: local upload via SFTP. Prototype scope: we lay out the
  // shape but don't actually transfer — the upload step would tar the
  // bundled `kolu-remote-agent/dist` directory, scp it to the remote,
  // and extract under the version-pinned path. A real implementation
  // also handles the cross-arch matrix (darwin-arm64, linux-x64,
  // linux-arm64) and verifies the destination version after extract.
  log.warn(
    { host, agentPath: path },
    "TODO Phase 2a: implement SFTP upload of bundled kolu-remote-agent — assuming manual install in prototype",
  );
  throw new Error(
    `kolu-remote-agent not found at ${path} on ${host} (manual install required in prototype)`,
  );
}

/** Run `ssh host '<path> --version'` and return true if it exits 0 and
 *  reports the expected version. Any failure → false (caller falls
 *  through to install). */
async function probeAgentVersion(
  host: string,
  remotePath: string,
  log: Logger,
): Promise<boolean> {
  return new Promise((resolve) => {
    const proc = spawn(
      "ssh",
      [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=5",
        host,
        `node ${remotePath} --version 2>/dev/null || echo MISSING`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf-8");
    });
    proc.on("exit", (code) => {
      if (code !== 0) {
        log.debug({ code, host, remotePath }, "ssh probe exited non-zero");
        resolve(false);
        return;
      }
      const matches = stdout.trim().includes(EXPECTED_AGENT_VERSION);
      log.debug({ stdout: stdout.trim(), matches, host }, "ssh probe result");
      resolve(matches);
    });
    proc.on("error", () => resolve(false));
  });
}
