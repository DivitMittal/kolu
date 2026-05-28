/**
 * Agent entry point — booted when the kolu binary is invoked with
 * `--stdio` (typically `ssh $host kolu --stdio` after the parent's
 * `HostSession` has copied + realised the .drv on the remote).
 *
 * The agent serves `agentSurface` over stdin/stdout via
 * `@kolu/surface/peer-server`. **Stdout is the protocol channel** — all
 * logging goes to fd 2, forced in `./log.ts` at module load when
 * `--stdio` is detected (lesson #4).
 *
 * **Scope**: spawn PTYs, expose data/cwd/title/commandRun streams,
 * fs/git procedures (delegated to `kolu-git`), and a basic
 * `terminalMetadata` collection seeded with `{ cwd }` from each spawn.
 * The full per-terminal provider DAG (claude/codex/opencode detectors,
 * git watcher, github PR watcher, foreground-process observer) lives
 * on the parent side via `LocalTerminalBackend` today; porting that to
 * run agent-side is a follow-up.
 *
 * Why a separate backend rather than reusing `LocalTerminalBackend`:
 * that module is a singleton wired to `surfaceCtx` (which carries the
 * parent's Conf-backed cells + autosave loop). The agent process
 * deliberately doesn't load `surface.ts` — it doesn't need user
 * preferences, an activity feed, or session restore, and pulling them
 * in would force disk-state directories at boot.
 */

import { ORPCError, implement } from "@orpc/server";
import {
  type ServeOverStdioOptions,
  serveOverStdio,
} from "@kolu/surface/peer-server";
import {
  type Channel,
  type ImplementSurfaceDeps,
  implementSurface,
  inMemoryChannel,
  inMemoryChannelByName,
} from "@kolu/surface/server";
import {
  type AgentTerminalMetadata,
  agentSurface,
} from "kolu-common/agentSurface";
import { DEFAULT_SCROLLBACK } from "kolu-common/config";
import type { TerminalId, TerminalInfo } from "kolu-common/surface";
import {
  getDiff,
  getStatus,
  listAll,
  readFile,
  statFileMtimeMs,
  subscribeFileChange,
  subscribeRepoChange,
} from "kolu-git";
import type { GitInfo } from "kolu-git/schemas";
import { type PtyHandle, spawnPty } from "kolu-pty";
import pkg from "../package.json" with { type: "json" };
import { unwrapGit } from "./gitUnwrap.ts";
import { ensureKoluRoot, koluShellDir } from "./koluRoot.ts";
import { log } from "./log.ts";
import {
  type ProviderHooks,
  type ProviderMeta,
  type ProviderRecord,
  startProviders,
} from "./terminalBackend/providers.ts";

export type AgentImplDeps = ImplementSurfaceDeps<typeof agentSurface.spec>;

interface AgentTerminal {
  info: TerminalInfo;
  handle: PtyHandle;
  meta: AgentTerminalMetadata;
  data: Channel<string>;
  cwd: Channel<string>;
  title: Channel<string>;
  commandRun: Channel<string>;
  /** Git-info bus the agent-side git watcher publishes onto and the
   *  github-PR watcher consumes — kept on the terminal record so the
   *  provider DAG can be torn down with the rest. */
  git: Channel<GitInfo | null>;
  /** Ephemeral basename of the agent binary at the foreground right
   *  now; written by the agent-command tracker, read by detectors. */
  currentAgent: string | null;
  stopProviders: () => void;
}

/** Wrap an agent-surface implementation in `serveOverStdio`. Centralises
 *  the load-bearing `implement(contract).router({...fragment.router})`
 *  re-wrap (which flattens the `surface.` prefix so requests don't 404)
 *  and the `router as any` cast that oRPC's `Router<any, T>` input type
 *  forces on `implementSurface`'s `Lazy<Router>` spread. Returns the
 *  promise from `serveOverStdio` plus the fragment so callers can hook
 *  per-event publishers (e.g. `terminalExit`) onto `fragment.ctx`. */
export function serveAgent(
  deps: AgentImplDeps,
  opts: Omit<ServeOverStdioOptions<object>, "router"> = {},
): {
  fragment: ReturnType<typeof implementSurface<typeof agentSurface.spec>>;
  serveDone: Promise<void>;
} {
  const fragment = implementSurface(agentSurface, deps);
  const router = implement(agentSurface.contract).router({
    ...fragment.router,
  });
  const serveDone = serveOverStdio({
    // biome-ignore lint/suspicious/noExplicitAny: implementSurface's Lazy<Router> spread isn't accepted by oRPC's Router<any, T> input type; runtime shape is valid (same pattern as kolu's main server.ts and the remote-process-monitor demo).
    router: router as any,
    ...opts,
  });
  return { fragment, serveDone };
}

/** Per-terminal seed metadata. The agent has no provider DAG yet, so
 *  `git`, `agent`, `pr`, `foreground`, `lastAgentCommand`,
 *  `lastActivityAt` stay defaulted. */
function seedMetadata(cwd: string): AgentTerminalMetadata {
  // Agent terminals are "local" from the agent's perspective. When the
  // parent mirrors this collection into its own `terminalMetadata`,
  // it overwrites `location` with `{kind:"remote", host}`.
  return {
    cwd,
    git: null,
    pr: { kind: "pending" },
    agent: null,
    foreground: null,
    lastActivityAt: 0,
    location: { kind: "local" },
  };
}

/** Build the implementation deps for `agentSurface`, given an internal
 *  terminal map + metadata snapshot + a publishExit callback that the
 *  caller wires after the fragment is built. `publishMetadata` is the
 *  publish-side companion to the deps' storage `upsert` — calling it
 *  fires the framework's keyed channel so the parent's
 *  `mirrorRemoteCollection` sees the update. Forward-refed like
 *  `publishExit`. */
export function buildAgentDeps(opts: {
  terminals: Map<TerminalId, AgentTerminal>;
  metadataSnapshot: Map<TerminalId, AgentTerminalMetadata>;
  publishExit: (id: TerminalId, exitCode: number) => void;
  publishMetadata: (id: TerminalId, meta: AgentTerminalMetadata) => void;
  publishMetadataRemove: (id: TerminalId) => void;
}): AgentImplDeps {
  const {
    terminals,
    metadataSnapshot,
    publishExit,
    publishMetadata,
    publishMetadataRemove,
  } = opts;

  function requireTerminal(id: TerminalId): AgentTerminal {
    const t = terminals.get(id);
    if (!t)
      throw new ORPCError("NOT_FOUND", {
        message: `terminal ${id} not found on agent`,
      });
    return t;
  }

  return {
    channel: inMemoryChannelByName(),
    collections: {
      terminalMetadata: {
        readAll: () => metadataSnapshot,
        upsert: (key, value) => {
          metadataSnapshot.set(key, value);
        },
        remove: (key) => {
          metadataSnapshot.delete(key);
        },
      },
    },
    streams: {
      terminalData: {
        source: async function* ({ id }, signal) {
          yield* requireTerminal(id).data.subscribe(signal);
        },
      },
      terminalCwd: {
        source: async function* ({ id }, signal) {
          yield* requireTerminal(id).cwd.subscribe(signal);
        },
      },
      terminalTitle: {
        source: async function* ({ id }, signal) {
          yield* requireTerminal(id).title.subscribe(signal);
        },
      },
      terminalCommandRun: {
        source: async function* ({ id }, signal) {
          yield* requireTerminal(id).commandRun.subscribe(signal);
        },
      },
      fsRepoChange: {
        source: async function* ({ repoPath }, signal) {
          yield* watchToStream(signal, (onChange) =>
            subscribeRepoChange(repoPath, onChange, log),
          );
        },
      },
      fsFileChange: {
        source: async function* ({ repoPath, filePath }, signal) {
          yield* watchToStream(signal, (onChange) =>
            subscribeFileChange(repoPath, filePath, onChange, log),
          );
        },
      },
    },
    procedures: {
      system: {
        heartbeat: async () => ({ ok: true, pid: process.pid }),
      },
      terminal: {
        spawn: async ({ input }) => {
          if (terminals.has(input.id)) {
            throw new ORPCError("CONFLICT", {
              message: `terminal ${input.id} already exists on agent`,
            });
          }
          const tlog = log.child({ terminal: input.id });
          const data = inMemoryChannel<string>();
          const cwdCh = inMemoryChannel<string>();
          const title = inMemoryChannel<string>();
          const commandRun = inMemoryChannel<string>();
          const gitCh = inMemoryChannel<GitInfo | null>();
          const handle = spawnPty(
            tlog,
            input.id,
            {
              rcDir: koluShellDir,
              termProgramVersion: pkg.version,
              scrollback: DEFAULT_SCROLLBACK,
              onData: (chunk) => data.publish(chunk),
              onExit: (exitCode) => {
                tlog.info({ exitCode }, "exited");
                const t = terminals.get(input.id);
                if (t) {
                  t.stopProviders();
                  terminals.delete(input.id);
                }
                // Route removal through the surface collection so the
                // `keysBus` fires and the parent's `mirrorRemoteCollection`
                // sees the key depart — without this, the parent's
                // per-key `get` stream stays open for an exited remote
                // terminal. `publishMetadataRemove` also clears
                // `metadataSnapshot`, so we no longer delete it
                // directly here.
                publishMetadataRemove(input.id);
                publishExit(input.id, exitCode);
              },
              onTitleChange: (t) => title.publish(t),
              onCommandRun: (raw) => commandRun.publish(raw),
              onCwd: (next) => {
                const t = terminals.get(input.id);
                if (t) {
                  t.meta = { ...t.meta, cwd: next };
                  publishMetadata(input.id, t.meta);
                }
                cwdCh.publish(next);
              },
            },
            input.cwd,
          );
          const meta = seedMetadata(handle.cwd);
          const info: TerminalInfo = { id: input.id, pid: handle.pid };
          const agentTerminal: AgentTerminal = {
            info,
            handle,
            meta,
            data,
            cwd: cwdCh,
            title,
            commandRun,
            git: gitCh,
            currentAgent: null,
            stopProviders: () => {},
          };
          terminals.set(input.id, agentTerminal);
          publishMetadata(input.id, meta);

          // Start the full per-terminal provider DAG (foreground
          // process observer, agent-command tracker, git watcher,
          // github PR watcher, claude/codex/opencode detectors).
          // Each provider mutates `agentTerminal.meta` in-place and
          // republishes through `publishMetadata` so the parent's
          // `mirrorRemoteCollection` sees the update.
          //
          // The provider DAG reads files (git/sqlite/JSONL) that
          // live on the REMOTE machine — running on the agent
          // means detection sees the real state, not a stale
          // parent-side guess.
          agentTerminal.stopProviders = startProviders(
            providerRecordFor(agentTerminal),
            input.id,
            {
              cwd: cwdCh,
              title,
              commandRun,
              git: gitCh,
            },
            buildProviderHooks(agentTerminal, input.id, publishMetadata),
          );
          tlog.info({ pid: handle.pid }, "spawned");
          return info;
        },
        kill: async ({ input }) => {
          const t = terminals.get(input.id);
          if (!t) return null;
          log
            .child({ terminal: input.id })
            .info({ pid: t.info.pid }, "killing");
          // Dispose triggers `onExit` which cleans up the map.
          t.handle.dispose();
          return t.info;
        },
        write: async ({ input }) => {
          requireTerminal(input.id).handle.write(input.data);
        },
        resize: async ({ input }) => {
          requireTerminal(input.id).handle.resize(input.cols, input.rows);
        },
        getScreenState: async ({ input }) =>
          requireTerminal(input.id).handle.getScreenState(),
        getScreenText: async ({ input }) =>
          requireTerminal(input.id).handle.getScreenText(
            input.startLine,
            input.endLine,
          ),
      },
      fs: {
        listAll: async ({ input }) => ({
          paths: unwrapGit(await listAll(input.repoPath, log)),
        }),
        readFile: async ({ input }) => {
          // The agent always returns `{content, truncated}` —
          // `kind: "binary"` URLs are a parent-side concern (the URL
          // points at the parent's HTTP file route which doesn't
          // exist on the agent).
          return unwrapGit(await readFile(input.repoPath, input.filePath, log));
        },
        statFileMtimeMs: async ({ input }) =>
          unwrapGit(await statFileMtimeMs(input.repoPath, input.filePath, log)),
      },
      git: {
        getStatus: async ({ input }) =>
          unwrapGit(await getStatus(input.repoPath, input.mode, log)),
        getDiff: async ({ input }) =>
          unwrapGit(
            await getDiff(
              input.repoPath,
              input.filePath,
              input.mode,
              log,
              input.oldPath,
            ),
          ),
      },
    },
  };
}

/** Adapt an `AgentTerminal` to the `ProviderRecord` shape the provider
 *  DAG consumes. The mutable `meta` and `currentAgent` are aliased
 *  (not cloned) so provider writes land back on the original
 *  agent-side record. */
function providerRecordFor(t: AgentTerminal): ProviderRecord {
  // ProviderMeta is the union of the fields the providers actually
  // touch; AgentTerminalMetadata adds connectionState (parent-only)
  // and location (which the agent always writes as `{kind:"local"}`).
  // The cast is sound — providers never read fields that
  // AgentTerminalMetadata is missing.
  return {
    ptyHandle: t.handle,
    meta: t.meta as unknown as ProviderMeta,
    get currentAgent() {
      return t.currentAgent;
    },
    set currentAgent(v: string | null) {
      t.currentAgent = v;
    },
  };
}

/** Build `ProviderHooks` for one agent terminal. The two update verbs
 *  mutate `agentTerminal.meta` then call `publishMetadata` so the
 *  parent's `mirrorRemoteCollection` sees the change. `trackRecentRepo`/
 *  `trackRecentAgent` stay undefined — the parent owns the user-facing
 *  activity feed. */
function buildProviderHooks(
  agentTerminal: AgentTerminal,
  terminalId: TerminalId,
  publishMetadata: (id: TerminalId, meta: AgentTerminalMetadata) => void,
): ProviderHooks {
  const apply = (mutate: (m: ProviderMeta) => void) => {
    mutate(agentTerminal.meta as unknown as ProviderMeta);
    publishMetadata(terminalId, agentTerminal.meta);
  };
  return {
    updateServerMetadata: (_record, mutate) => apply(mutate),
    updateServerLiveMetadata: (_record, mutate) => apply(mutate),
  };
}

/** Adapt a `subscribe(cb): () => void` watcher into an async iterable
 *  of yielded `{}` ticks. The watcher fires `cb()` on each underlying
 *  event; we yield once per event (coalescing bursts that arrive before
 *  the consumer pulls the next value). Signal abort tears down the
 *  watcher and exits the loop. */
async function* watchToStream(
  signal: AbortSignal | undefined,
  subscribe: (onChange: () => void) => () => void,
): AsyncGenerator<Record<string, never>> {
  let pending = 0;
  let resolveNext: (() => void) | null = null;
  const unsub = subscribe(() => {
    pending += 1;
    resolveNext?.();
    resolveNext = null;
  });
  const onAbort = () => {
    resolveNext?.();
    resolveNext = null;
  };
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal?.aborted) {
      if (pending === 0) {
        await new Promise<void>((r) => {
          resolveNext = r;
        });
        if (signal?.aborted) break;
      }
      pending = 0;
      yield {};
    }
  } finally {
    unsub();
    signal?.removeEventListener("abort", onAbort);
  }
}

export async function runAgent(): Promise<void> {
  process.on("uncaughtException", (err) => {
    log.fatal({ err }, "uncaught exception");
    process.exit(1);
  });
  process.on("unhandledRejection", (reason) => {
    log.fatal({ reason }, "unhandled rejection");
    process.exit(1);
  });

  // `koluShellDir` needs the kolu state root to exist before
  // `spawnPty` can write rc files there.
  ensureKoluRoot();

  // `pid` already lives on `baseAgent` (log.ts) — pino adds it to every
  // line. Passing it again here would produce duplicate JSON keys.
  log.info("agent starting");

  const terminals = new Map<TerminalId, AgentTerminal>();
  const metadataSnapshot = new Map<TerminalId, AgentTerminalMetadata>();

  // `publishExit` and `publishMetadata` are wired after `serveAgent`
  // builds the fragment — neither can fire before the spawn handler
  // runs (which only happens via an inbound RPC, i.e. after the wire
  // is alive), so the forward-ref no-op default is safe.
  let publishExit: (id: TerminalId, exitCode: number) => void = () => {};
  let publishMetadata: (id: TerminalId, meta: AgentTerminalMetadata) => void =
    () => {};
  let publishMetadataRemove: (id: TerminalId) => void = () => {};
  const deps = buildAgentDeps({
    terminals,
    metadataSnapshot,
    publishExit: (id, ec) => publishExit(id, ec),
    publishMetadata: (id, meta) => publishMetadata(id, meta),
    publishMetadataRemove: (id) => publishMetadataRemove(id),
  });

  log.info("serving agent surface over stdio");
  const { fragment, serveDone } = serveAgent(deps, {
    onFirstRequest: () => log.info("first RPC received — link is live"),
  });
  publishExit = (id, exitCode) =>
    fragment.ctx.events.terminalExit.publish({ id }, exitCode);
  publishMetadata = (id, meta) =>
    fragment.ctx.collections.terminalMetadata.upsert(id, meta);
  publishMetadataRemove = (id) =>
    fragment.ctx.collections.terminalMetadata.remove(id);

  // Graceful shutdown — parent's HostSession.teardown sends SIGTERM
  // when it disposes a session. Log the signal before exit so the
  // parent's forwarded `[host:<host> remote]` trace shows the agent
  // closing intentionally, not vanishing. Dispose every PTY before
  // exit so the shells don't leak as children of init.
  for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"] as const) {
    process.on(sig, () => {
      log.info({ signal: sig }, "agent shutting down");
      for (const t of terminals.values()) t.handle.dispose();
      process.exit(0);
    });
  }

  await serveDone;
  log.info("stdin closed — agent exiting");
}
