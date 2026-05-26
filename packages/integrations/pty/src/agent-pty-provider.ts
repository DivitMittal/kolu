/**
 * Agent-routed PTY provider — Phase 3 of kolu#951. PTYs live on the
 * remote agent process instead of the local `ssh -tt` subprocess, so
 * they survive ssh drops.
 *
 * Replaces `sshPtyProvider` for SSH terminals once Phase 3 lands. The
 * caller (kolu-server's `createTerminal`) hands this provider a
 * `HostSession` plus optional `remoteSessionId` — on first spawn the
 * agent allocates a new session id; on session restore the same id
 * reattaches with a fresh scrollback snapshot.
 *
 * The returned `PtyHandle` looks identical to a local PTY's: same
 * data/exit callbacks, same `write` / `resize` / `dispose`. The local
 * xterm-headless still parses OSC sequences for the screen-state
 * snapshot; the local emulator's `onData` is fed from RPC events
 * instead of a node-pty subprocess.
 *
 * **Prototype scope.** The shape is right; the agent-side
 * `terminal.spawn` / `terminal.attach` handlers (and the headless
 * xterm integration on the agent side) are stubbed in
 * `kolu-remote-agent/src/index.ts` with `TODO Phase 3` markers.
 */

import type { Logger } from "kolu-shared";
import type { PtyHandle, PtyProvider, PtySpawnOptions } from "./pty.ts";

export interface AgentPtyProviderOptions {
  host: string;
  /** Session handle the provider drives — exposed via the narrow
   *  HostSessionLike-style interface so this package stays free of
   *  kolu-server imports. */
  session: {
    call(method: string, args: unknown): Promise<unknown>;
    subscribe(
      method: string,
      args: unknown,
      onEvent: (payload: unknown) => void,
    ): {
      update(params: unknown): Promise<void>;
      close(): Promise<void>;
    };
  };
  /** Persisted session id from a prior run — when set, the provider
   *  calls `terminal.attach` instead of `terminal.spawn`, recovering
   *  the still-running PTY on the remote. */
  remoteSessionId?: string;
  /** Callback fired after a successful spawn/attach with the resolved
   *  remoteSessionId — the server-side caller persists this onto
   *  `ServerPersistedTerminalFields.remoteSessionId` so session
   *  restore can reattach. */
  onSessionAllocated?: (remoteSessionId: string) => void;
}

interface AgentPtyMessage {
  /** `"data"` for stdout bytes (string), `"exit"` for terminal exit
   *  (numeric code). Phase 3 prototype protocol — Phase 3.x can grow
   *  resize, title, etc. */
  kind: "data" | "exit";
  payload: string | number;
}

export function agentPtyProvider(opts: AgentPtyProviderOptions): PtyProvider {
  return {
    spawn(
      tlog: Logger,
      _terminalId: string,
      spawnOpts: PtySpawnOptions,
      spawnCwd?: string,
    ): PtyHandle {
      let token: ReturnType<typeof opts.session.subscribe> | null = null;
      let allocatedSessionId: string | null = opts.remoteSessionId ?? null;
      let disposed = false;

      // Phase 3: subscribe to the agent's terminal stream. The agent
      // sends a tagged-union: `{kind:"data", payload:string}` for
      // bytes, `{kind:"exit", payload:number}` for exit.
      const onEvent = (raw: unknown): void => {
        const msg = raw as AgentPtyMessage;
        if (msg.kind === "data" && typeof msg.payload === "string") {
          spawnOpts.onData(msg.payload);
        } else if (msg.kind === "exit" && typeof msg.payload === "number") {
          spawnOpts.onExit(msg.payload);
        }
      };

      // Kick off spawn-or-attach. The actual subscribe is async; we
      // hand back a handle synchronously and the data callbacks start
      // firing once the agent responds.
      const method = allocatedSessionId ? "terminal.attach" : "terminal.spawn";
      const args = allocatedSessionId
        ? { remoteSessionId: allocatedSessionId }
        : { cwd: spawnCwd, cols: 80, rows: 24 };
      token = opts.session.subscribe(method, args, onEvent);

      // For spawn, the agent's response carries the new remoteSessionId.
      // We retrieve it via a separate call after subscribing (the
      // subscribe path returns a token id immediately; the session-id
      // metadata is fetched once via a `terminal.info` round-trip).
      if (!allocatedSessionId) {
        void opts.session
          .call("terminal.info", { spawnTag: method })
          .then((info) => {
            const id = (info as { remoteSessionId?: string }).remoteSessionId;
            if (id) {
              allocatedSessionId = id;
              opts.onSessionAllocated?.(id);
            }
          })
          .catch((err: Error) => {
            tlog.error({ err }, "agent terminal.info failed");
          });
      }

      return {
        // For agent-owned PTYs there's no local OS pid that maps to
        // the remote shell; we synthesize a positive number from the
        // session id so consumers that read .pid for logging see
        // something stable, while location.kind !== "local" gates
        // anything semantically meaningful (already established in
        // Phase 0).
        pid: 0,
        cwd: spawnCwd ?? "/",
        // Remote-owned: local kernel reads are not meaningful. Phase
        // 0's gating in meta/agent.ts + meta/process.ts skips them.
        localProcess: "ssh",
        localForegroundPid: undefined,
        write: (data: string) => {
          if (disposed) return;
          void opts.session
            .call("terminal.write", {
              remoteSessionId: allocatedSessionId,
              data,
            })
            .catch((err: Error) => {
              tlog.warn({ err }, "agent terminal.write failed");
            });
        },
        resize: (cols: number, rows: number) => {
          if (disposed) return;
          void opts.session
            .call("terminal.resize", {
              remoteSessionId: allocatedSessionId,
              cols,
              rows,
            })
            .catch((err: Error) => {
              tlog.warn({ err }, "agent terminal.resize failed");
            });
        },
        // Phase 3 prototype: getScreenState / getScreenText return empty
        // strings — late-join clients need the agent's scrollback
        // snapshot, which gets stitched in once the agent's handler
        // lands. The schema/wiring is in place; the agent-side bytes
        // are the missing piece.
        getScreenState: () => "",
        getScreenText: () => "",
        dispose: () => {
          disposed = true;
          if (token) void token.close();
          // The agent's terminal session keeps running on close — the
          // user gets reattach on next launch. Explicit kill happens
          // via a separate `terminal.kill` call (not implemented in
          // the prototype; for now the agent's idle-TTL collects).
        },
      };
    },
  };
}
