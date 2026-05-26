/**
 * Backend — the per-terminal world a terminal lives in.
 *
 * A `Backend` is identified by `BackendId` (local machine, or a specific
 * SSH host) and owns every per-terminal stream + one-shot op a terminal
 * needs. R-1 shipped `LocalBackend`; R-2 adds `RemoteBackend` whose
 * methods proxy via oRPC over `ssh stdio` to a `kolu agent --stdio`
 * peer.
 *
 * The interface is the single transport boundary in the system. The
 * server's `meta/*.ts` orchestrators are dissolved into `LocalBackend`
 * (provider startup is now internal to `spawnPty`); the kolu server
 * invokes `backend.terminalChannel(id, "git")` and forwards. It does
 * not import from `kolu-git` directly for terminal-scoped work.
 *
 * Streaming methods follow the snapshot-then-delta invariant
 * (`.claude/rules/streaming.md`). The first yield is always a snapshot;
 * subsequent yields are deltas. `RemoteBackend` reuses oRPC's
 * `STREAM_RETRY` plumbing — `kolu agent --stdio` is just another oRPC
 * peer, no bespoke reconnect logic needed.
 *
 * R-2 expanded the channel set so remote terminals' rich surfaces
 * (agent badge, PR badge, foreground process, connection state) work
 * over the wire — pre-implementation review (finding B) caught that
 * R-1's channel set was insufficient; without these channels, remote
 * tiles silently lose all rich-surface metadata.
 *
 * Invariants:
 *
 * 1. **Kill convergence.** `Backend.killTerminal(id)` is the SOLE
 *    termination path. `TerminalHandle` no longer carries `dispose()` —
 *    handle-as-control-surface and kill-as-lifecycle were two roles
 *    smuggled through one method. R-2 pre-impl finding H.
 *
 * 2. **Snapshot-then-delta streams.** Every `terminalChannel<K>`
 *    iterator's first yield is a full state snapshot; subsequent yields
 *    are deltas.
 *
 * 3. **Backend owns its filesystem.** `BackendFs`/`BackendGit` cover
 *    both one-shot ops AND watcher subscriptions — same axis ("where
 *    the FS lives"). R-2 closes the R-1 gap where `surface.ts` streams
 *    called `kolu-git` directly.
 */

import type {
  AgentInfo,
  ConnectionState,
  Foreground,
  TerminalLocation,
} from "./surface";
import type {
  GitDiffMode,
  GitDiffOutput,
  GitInfo,
  GitStatusOutput,
} from "kolu-git/schemas";
import type { PrResult } from "kolu-github/schemas";
import type { InitialTerminalMetadata } from "./surface";

/** Seed metadata for a new terminal. */
export interface TerminalSeed extends InitialTerminalMetadata {
  /** Sub-terminal link. Location inheritance (a child of a remote tile
   *  spawns on the same host) is the resolver's job — see
   *  `getBackendForCreate` in `packages/server/src/backend/index.ts`. */
  parentId?: string;
}

export interface PtySpawnOpts {
  /** Caller-supplied terminal id. Optional: backends generate one
   *  when absent. RemoteBackend pre-generates an id so it can register
   *  a "connecting" shadow entry on the kolu server BEFORE the agent's
   *  spawn RPC roundtrips — that's what makes the tile appear
   *  instantly while ssh + nix run realise the closure. The agent
   *  honors the same id so kolu server <-> agent registries stay in
   *  lockstep. */
  id?: string;
  cwd?: string;
  initialMetadata?: TerminalSeed;
  /** Fires on PTY exit with `wasNatural` distinguishing shell-exited
   *  from explicit-kill. See module doc. */
  onExit?: (exitCode: number, wasNatural: boolean) => void;
}

/** A live terminal owned by a backend. Pure control-surface — write
 *  input, change dimensions. Termination is `Backend.killTerminal(id)`,
 *  not on the handle (kill-convergence invariant). */
export interface TerminalHandle {
  readonly id: string;
  write(data: string): void;
  resize(cols: number, rows: number): void;
}

/** Per-terminal streaming channels. Snapshot-then-delta on every key.
 *
 *  R-2 channel-set expansion:
 *  - `agent`, `pr`, `foreground` — were written by in-process providers
 *    on R-1, which works for local but is invisible to RemoteBackend.
 *    Now flow over channels so the agent process's providers reach the
 *    kolu server.
 *  - `connectionState` — driven by `HostSession`'s state machine for
 *    remote terminals; `LocalBackend` publishes "live" once at spawn. */
export interface TerminalChannelMap {
  /** Raw PTY bytes — high-throughput stream. */
  data: string;
  /** OSC 7 cwd updates. */
  cwd: string;
  /** OSC 0/2 title updates. */
  title: string;
  /** Git context for the terminal's cwd. */
  git: GitInfo | null;
  /** OSC 633;E preexec command lines (raw). */
  commandRun: string;
  /** AI coding agent state (Claude Code, OpenCode, Codex). */
  agent: AgentInfo | null;
  /** GitHub PR resolution. */
  pr: PrResult;
  /** Foreground process detected via OSC 2 / kqueue. */
  foreground: Foreground | null;
  /** Backend connection state — `"live"` for local, transitions
   *  through `"connecting"` / `"disconnected"` for remote. */
  connectionState: ConnectionState;
}

/** Filesystem ops scoped to the backend's filesystem.
 *
 *  Subscription methods return AsyncIterables so the same shape carries
 *  over oRPC (RemoteBackend) and over in-process callbacks
 *  (LocalBackend wraps `kolu-git`'s callback-based watchers via an
 *  async generator). The yielded `void` is a "something changed"
 *  signal — consumers re-read via `listAll` / `readFile`. */
export interface BackendFs {
  listAll(repoPath: string): Promise<string[]>;
  readFile(
    repoPath: string,
    filePath: string,
  ): Promise<{ content: string; truncated: boolean }>;
  /** Yield once per filesystem change anywhere under `repoPath`. The
   *  first yield is a no-op snapshot so consumers can `read` once
   *  before the first delta arrives. */
  subscribeRepoChange(
    repoPath: string,
    signal?: AbortSignal,
  ): AsyncIterable<void>;
  /** Yield once per filesystem change to `filePath` (or its containing
   *  dir, for create/delete). */
  subscribeFileChange(
    repoPath: string,
    filePath: string,
    signal?: AbortSignal,
  ): AsyncIterable<void>;
}

export interface BackendGit {
  getDiff(
    repoPath: string,
    filePath: string,
    mode: GitDiffMode,
    oldPath?: string,
  ): Promise<GitDiffOutput>;
  getStatus(repoPath: string, mode: GitDiffMode): Promise<GitStatusOutput>;
  // Subscription lives on `BackendFs.subscribeRepoChange` only —
  // post-impl Lowy F1: the git watcher and fs watcher are the same
  // parcel-watcher subscription, just renamed. One axis, one site.
}

/**
 * The Backend interface — see module doc.
 *
 * Per-terminal screen-state reads (`getScreenState`, `getScreenText`)
 * stay on `entry.handle` (the kolu server's `TerminalControl` view of a
 * terminal) — emulator state is per-terminal local state and survives
 * backend swaps. Callers go through the registry, not this interface.
 */
export interface Backend {
  /** Stable identity — `{ kind: "local" }` or `{ kind: "ssh", host }`. */
  readonly id: TerminalLocation;

  /** Create a new terminal owned by this backend. */
  spawnPty(opts: PtySpawnOpts): Promise<TerminalHandle>;

  /** Subscribe to a terminal's stream of `kind`. Snapshot-then-delta. */
  terminalChannel<K extends keyof TerminalChannelMap>(
    terminalId: string,
    kind: K,
    signal?: AbortSignal,
  ): AsyncIterable<TerminalChannelMap[K]>;

  /** Kill a terminal. Single termination path — see kill-convergence
   *  invariant in module doc. Returns `true` if the kill ran. */
  killTerminal(terminalId: string): boolean;

  /** Bulk-kill teardown for `killAllTerminals` — the drain-before-
   *  dispose pattern has already emptied the registry, so this
   *  variant takes the entry directly. RemoteBackend reads only
   *  `entry.info.id` (and RPCs); LocalBackend uses the full handle +
   *  stopProviders. The wide structural type honors both. */
  killTerminalEntry(entry: {
    info: { id: string };
    handle: { dispose(): void };
    stopProviders: () => void;
  }): void;

  /** Save uploaded bytes into the backend's per-terminal scratch
   *  directory and return the absolute path the agent on this backend
   *  sees. Used by `terminal.pasteImage` / `terminal.uploadFile` —
   *  R-1's implementation in `router.ts` wrote to the kolu-server's
   *  local scratch dir, which is the wrong host for remote tiles.
   *  R-2 finding I. */
  uploadFile(
    terminalId: string,
    name: string,
    base64Data: string,
  ): Promise<string>;

  /** Filesystem + git ops on the backend's filesystem. */
  readonly fs: BackendFs;
  readonly git: BackendGit;
}
