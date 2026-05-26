/**
 * SSH-wrapped PTY provider — Phase 1 of kolu#951.
 *
 * Spawns a local `ssh -tt <host>` subprocess with the remote shell as
 * the command, then hands the PTY off to the existing `spawnPty`
 * machinery. The local headless xterm parses the remote shell's OSC 7
 * (cwd) / OSC 0/2 (title) / OSC 633;E (preexec command) sequences
 * transparently because escape codes pass through ssh untouched.
 *
 * Symmetry with Zed's `create_remote_shell`
 * (`/tmp/zed/crates/project/src/terminals.ts:609`): one local ssh
 * subprocess per remote terminal, no PTY-over-RPC. Phase 3 replaces
 * this with `AgentPtyProvider` so PTYs survive ssh drops.
 */

import type { Logger } from "kolu-shared";
import type { PtyHandle, PtyProvider, PtySpawnOptions } from "./pty.ts";
import { spawnPty } from "./pty.ts";

/** Command shape ssh runs on the remote: `cd <cwd> && exec env … $SHELL -l`.
 *  Mirrors Zed's `build_command_posix`
 *  (`/tmp/zed/crates/remote/src/transport/ssh.rs:1768`). The `cd` honours
 *  `~/` via `$HOME`; the `exec env` chain inherits the env we hand to
 *  spawnPty (TERM_PROGRAM, scrollback, etc.); the trailing `$SHELL -l`
 *  is a login shell so the remote `~/.bashrc` / `~/.zshrc` runs. */
function buildRemoteCommand(spawnCwd: string | undefined): string {
  // Quote $HOME (left unquoted so the remote shell expands it) and the
  // working-dir tail (single-quoted, no expansion).
  let cdSegment = "";
  if (spawnCwd) {
    if (spawnCwd.startsWith("~/")) {
      const remainder = spawnCwd.slice(2);
      cdSegment = remainder
        ? `cd "$HOME"/'${remainder.replace(/'/g, "'\\''")}' && `
        : `cd "$HOME" && `;
    } else {
      cdSegment = `cd '${spawnCwd.replace(/'/g, "'\\''")}' && `;
    }
  }
  return `${cdSegment}exec env $SHELL -l`;
}

/** Build the argv passed to local `ssh`. `-tt` forces TTY allocation
 *  (twice so ssh doesn't bail on non-tty stdin), `-o BatchMode=yes`
 *  short-circuits interactive password prompts (key-based auth only).
 *  Phase 1 is intentionally minimal: no ControlMaster, no port
 *  forwarding — those come with Phase 2a's HostSession. */
function buildSshArgs(host: string, remoteCommand: string): string[] {
  return [
    "-tt",
    "-o",
    "BatchMode=yes",
    "-o",
    "ServerAliveInterval=30",
    host,
    remoteCommand,
  ];
}

/** Factory: each remote terminal asks for a fresh provider keyed on
 *  host. Stateless across terminals — there's no per-host state to
 *  share at this layer; the ssh client process holds the connection.
 *  Phase 3 will swap this for an agent-routed variant. */
export function sshPtyProvider(host: string): PtyProvider {
  return {
    spawn(
      tlog: Logger,
      terminalId: string,
      opts: PtySpawnOptions,
      spawnCwd?: string,
    ): PtyHandle {
      const remoteCommand = buildRemoteCommand(spawnCwd);
      const args = buildSshArgs(host, remoteCommand);

      tlog.info({ host, spawnCwd }, "spawning ssh-wrapped pty");

      // spawnPty's `shell` argument is the local executable. For ssh-wrapped
      // PTYs that's "ssh", and the remote shell is run via the trailing
      // `exec $SHELL -l`. We feed args via the spawnPty hook by treating
      // its shell-init opts as opaque — the rc-dir / hooks aren't relevant
      // for the ssh child (the remote shell sources its own rc).
      //
      // For Phase 1 we sidestep the rc-injection path: the local ssh
      // doesn't read kolu's bash/zsh rc, so onTitleChange / onCwd /
      // onCommandRun will fire only when the *remote* shell emits OSC
      // sequences (which it does if the user runs Claude/Codex; bare
      // sh prompts won't emit them). The kolu rc gets installed on the
      // remote later via Phase 2a's agent bootstrap.
      // Pass undefined as spawnCwd so the local pty.spawn doesn't try
      // to chdir to a (potentially remote-only) path before exec. The
      // cd happens on the remote inside the ssh command itself.
      return spawnPty(tlog, terminalId, opts, undefined, {
        program: "ssh",
        programArgs: args,
      });
    },
  };
}
