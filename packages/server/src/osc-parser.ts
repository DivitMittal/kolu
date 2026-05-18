/**
 * OSC 7 / OSC 2 / OSC 633;E parser shared by local and remote PTYs.
 *
 * Both the local-PTY producer (`pty.ts:spawnPty`) and the remote
 * RemoteHost producer (`host/remote.ts:spawnPty`) feed PTY bytes into
 * a headless xterm and need the same three sequences extracted:
 *
 *   - OSC 7   — cwd (`file://hostname/path`)
 *   - OSC 0/2 — title (signals foreground process may have changed)
 *   - OSC 633 ; E ; <cmd> — VS Code's exact-command preexec mark
 *
 * The single shared implementation here removes the duplication the
 * Hickey review (CM1) flagged: adding OSC 133, changing OSC 7 handling,
 * or evolving any of these handlers used to require touching two files.
 */

export interface OscParserOpts {
  onCwd?(cwd: string): void;
  onTitleChange?(title: string): void;
  onCommandRun?(command: string): void;
  onDebug?(payload: Record<string, unknown>, message: string): void;
}

export interface OscParserHandle {
  /** Current cwd as last reported by OSC 7. Starts at the initial cwd
   *  passed in at attach time; updated synchronously when OSC 7 fires. */
  currentCwd(): string;
  /** Tear down every handler registered by `attachOscParser`. The
   *  caller still owns the headless terminal itself. */
  dispose(): void;
}

interface Disposable {
  dispose(): void;
}

interface OscRegistrar {
  registerOscHandler(
    code: number,
    handler: (data: string) => boolean,
  ): Disposable;
}

interface HeadlessLike {
  parser: OscRegistrar;
  onTitleChange(listener: (title: string) => void): Disposable;
}

export function attachOscParser(
  headless: HeadlessLike,
  initialCwd: string,
  opts: OscParserOpts,
): OscParserHandle {
  let cwd = initialCwd;

  // OSC 7 — file://hostname/path. We ignore the hostname for now (the
  // remote case will care later when path validation lands) and just
  // decode the path component.
  const oscCwd = headless.parser.registerOscHandler(7, (data: string) => {
    try {
      const url = new URL(data);
      if (url.protocol === "file:") {
        cwd = decodeURIComponent(url.pathname);
        opts.onDebug?.({ cwd }, "cwd changed (OSC 7)");
        opts.onCwd?.(cwd);
      }
    } catch {
      // Ignore malformed OSC 7 data.
    }
    return true;
  });

  // OSC 0/2 — title. Emitted by Kolu's preexec hook before each user
  // command. Drives event-driven foreground-process detection.
  const titleDisp = headless.onTitleChange((title: string) => {
    opts.onDebug?.({ title }, "title changed (OSC 0/2)");
    opts.onTitleChange?.(title);
  });

  // OSC 633 ; E ; <command> — VS Code's "exact command line" preexec
  // mark. We accept only the `E;` sub-code and let other 633;X
  // sequences (A/B/C/D) fall through untouched.
  const oscCmd = headless.parser.registerOscHandler(633, (data: string) => {
    if (!data.startsWith("E;")) return false;
    const command = data.slice(2);
    // DEBUG only: the raw command string is whatever the user typed,
    // including any ephemeral prompt text. Downstream normalization
    // strips prompt flags before any INFO-level log.
    opts.onDebug?.({ command }, "command run (OSC 633;E)");
    opts.onCommandRun?.(command);
    return true;
  });

  return {
    currentCwd: () => cwd,
    dispose() {
      oscCwd.dispose();
      titleDisp.dispose();
      oscCmd.dispose();
    },
  };
}
