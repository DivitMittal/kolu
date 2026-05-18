/**
 * Pure PTY lifecycle wrapper around node-pty.
 *
 * Transport-agnostic: communicates via onData/onExit callbacks.
 * Maintains a headless xterm instance for screen state serialization
 * on late-joining clients (~4KB vs raw scrollback replay).
 */

import { createRequire } from "node:module";
import {
  DEFAULT_COLS,
  DEFAULT_ROWS,
  DEFAULT_SCROLLBACK,
} from "kolu-common/config";
import * as pty from "node-pty";
import pkg from "../package.json" with { type: "json" };
import type { Logger } from "./log.ts";
import { attachOscParser } from "./osc-parser.ts";
import { cleanEnv, koluIdentityEnv, prepareShellInit } from "./shell.ts";

// @xterm packages ship CJS only — use createRequire for clean ESM interop
const require = createRequire(import.meta.url);
const { Terminal } =
  require("@xterm/headless") as typeof import("@xterm/headless");
const { SerializeAddon } =
  require("@xterm/addon-serialize") as typeof import("@xterm/addon-serialize");

/** Extract plain text from an xterm buffer within a line range. */
export function getScreenText(
  buffer: {
    length: number;
    getLine(
      i: number,
    ): { translateToString(trimRight: boolean): string } | undefined;
  },
  startLine?: number,
  endLine?: number,
): string {
  const start = Math.max(0, startLine ?? 0);
  const end = Math.min(buffer.length, endLine ?? buffer.length);
  const lines: string[] = [];
  for (let i = start; i < end; i++) {
    lines.push(buffer.getLine(i)?.translateToString(true) ?? "");
  }
  return lines.join("\n");
}

export interface PtyHandle {
  /** OS process ID of the spawned shell. */
  readonly pid: number;
  /** Current working directory (from OSC 7), initially $HOME. */
  readonly cwd: string;
  /** Current foreground process name (from node-pty). */
  readonly process: string;
  /**
   * Pid of the pty's current foreground process group leader (from
   * tcgetpgrp(3)), or `undefined` if not yet set. Used by metadata
   * providers to identify which process is running in the terminal.
   */
  readonly foregroundPid: number | undefined;
  /** Send input to the PTY (keystrokes, pasted text). */
  write(data: string): void;
  /** Resize the PTY grid. */
  resize(cols: number, rows: number): void;
  /** Serialized screen state (VT escape sequences) for late-joining clients. */
  getScreenState(): string;
  /** Plain text content of the terminal buffer (scrollback + viewport). */
  getScreenText(startLine?: number, endLine?: number): string;
  /** Kill the PTY process and release resources. */
  dispose(): void;
}

/** Spawn a shell in a PTY, calling back on data, exit, CWD, and title changes. */
export function spawnPty(
  tlog: Logger,
  terminalId: string,
  opts: {
    onData: (data: string) => void;
    onExit: (exitCode: number) => void;
    onCwd?: (cwd: string) => void;
    /** Fired on OSC 0/2 title change — signals foreground process may have changed. */
    onTitleChange?: (title: string) => void;
    /** Fired when the preexec hook emits `OSC 633 ; E ; <cmd>` — the raw
     *  command line the user typed, before execution. Used to build the
     *  global recent-agents MRU. */
    onCommandRun?: (command: string) => void;
  },
  spawnCwd?: string,
): PtyHandle {
  // Env layering, ordered from least to most authoritative:
  //   1. cleanEnv()         — parent env passthrough (Nix devshell filtering).
  //   2. koluIdentityEnv()  — Kolu's identity (TERM_PROGRAM, version,
  //                           VTE_VERSION); unconditionally stomps whatever
  //                           the parent had.
  //   3. shellInit.env      — per-PTY overrides (e.g. ZDOTDIR for zsh).
  const env = cleanEnv();
  const shell = env.SHELL ?? "/bin/sh";
  const cwd = spawnCwd || env.HOME || "/";

  Object.assign(env, koluIdentityEnv(pkg.version));

  const shellInit = prepareShellInit({
    shell,
    home: env.HOME,
    terminalId,
  });
  Object.assign(env, shellInit.env);

  tlog.debug({ shell, cwd }, "spawning pty");
  const proc = pty.spawn(shell, shellInit.args, {
    name: "xterm-256color",
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    cwd,
    env,
  });
  tlog.debug({ pid: proc.pid }, "pty spawned");

  // Sanity-check the node-pty fork's foregroundPid accessor — if upstream
  // changes drop it, fail loud here instead of silently breaking claude
  // detection. The accessor returns 0 momentarily before the child finishes
  // setsid, so any number (including 0) means the property exists.
  if (
    typeof (proc as unknown as { foregroundPid?: unknown }).foregroundPid !==
    "number"
  ) {
    throw new Error(
      "node-pty.foregroundPid accessor missing — fork patch may have regressed",
    );
  }

  // Headless terminal parses PTY output into screen state for serialization.
  // allowProposedApi is required for SerializeAddon to access the buffer.
  const headless = new Terminal({
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    scrollback: DEFAULT_SCROLLBACK,
    allowProposedApi: true,
  });
  const serializeAddon = new SerializeAddon();
  headless.loadAddon(serializeAddon);

  // Parse OSC 7 (CWD), OSC 0/2 (title), OSC 633;E (preexec command)
  // off the headless terminal stream. The shared `attachOscParser` is
  // used identically by RemoteHost's pty so the two producers can't
  // drift on OSC handling.
  const oscParser = attachOscParser(headless, cwd, {
    onCwd: opts.onCwd,
    onTitleChange: opts.onTitleChange,
    onCommandRun: opts.onCommandRun,
    onDebug: (payload, message) => tlog.debug(payload, message),
  });

  // Forward device query responses (DA1/DSR) from headless terminal back to
  // the PTY. TUIs like Yazi probe terminal capabilities at startup — the
  // headless terminal responds immediately, avoiding latency from the client.
  // Filter out OSC responses (e.g. OSC 10/11/12 color queries) — programs
  // don't consume these, so the shell echoes them as visible garbage.
  const headlessOnDataDisposable = headless.onData((data: string) => {
    if (data.startsWith("\x1b]")) return;
    proc.write(data);
  });

  const dataDisposable = proc.onData((data: string) => {
    headless.write(data);
    opts.onData(data);
  });

  const exitDisposable = proc.onExit(({ exitCode }) => opts.onExit(exitCode));

  return {
    pid: proc.pid,
    get cwd() {
      return oscParser.currentCwd();
    },
    get process() {
      return proc.process;
    },
    get foregroundPid() {
      // node-pty's IPty type doesn't expose this; the UnixTerminal class does.
      // tcgetpgrp can return 0 momentarily before the child finishes setsid —
      // collapse that to undefined so callers don't have to special-case it.
      const pid = (proc as unknown as { foregroundPid?: number }).foregroundPid;
      return pid && pid > 0 ? pid : undefined;
    },
    write: (data) => proc.write(data),
    resize: (cols, rows) => {
      proc.resize(cols, rows);
      headless.resize(cols, rows);
    },
    getScreenState: () => serializeAddon.serialize(),
    getScreenText: (startLine?: number, endLine?: number) =>
      getScreenText(headless.buffer.active, startLine, endLine),
    dispose() {
      oscParser.dispose();
      headlessOnDataDisposable.dispose();
      dataDisposable.dispose();
      exitDisposable.dispose();
      proc.kill();
      headless.dispose();
      shellInit.cleanup();
    },
  };
}
