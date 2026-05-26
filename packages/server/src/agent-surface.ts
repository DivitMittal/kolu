/**
 * Agent-surface implementation — wires `agentSurface` (from
 * `kolu-common/agentSurface`) to the in-process `localBackend` so the
 * agent process can serve the surface alongside (during migration) or
 * instead of (post-migration) the hand-rolled `agentContract`.
 *
 * What lives here:
 *
 *   - The `implementSurface` deps for `agentSurface` — collection
 *     readAll/upsert/remove, stream sources, procedure handlers — all
 *     delegating to `localBackend` and the terminal registry.
 *   - A per-terminal aggregator that subscribes to the legacy
 *     `terminalChannels` (cwd, git, agent, pr, foreground,
 *     commandRun, data) and republishes the aggregated
 *     `AgentTerminalMetadata` projection through the surface's
 *     `terminalMetadata` collection channel. Started at terminal
 *     spawn; stopped at kill.
 *   - The wired-up router fragment and surface ctx for `agent.ts` to
 *     merge into its top-level oRPC router.
 */

import { implement } from "@orpc/server";
import {
  agentSurface,
  type AgentTerminalMetadata,
} from "kolu-common/agentSurface";
import type { TerminalMetadata } from "kolu-common/surface";
import { implementSurface, inMemoryChannel } from "@kolu/surface/server";
import { localBackend } from "./backend/local.ts";
import { log } from "./log.ts";
import { terminalChannels } from "./publisher.ts";
import {
  getTerminal,
  registerTerminal as _registerTerminal,
  terminalEntries,
  unregisterTerminal as _unregisterTerminal,
} from "./terminal-registry.ts";
import { ORPCError } from "@orpc/server";

// Silence unused-import diagnostics — keep the imports as explicit
// declarations of what this module CAN reach for, even when the live
// surface deps don't reference them directly.
void _registerTerminal;
void _unregisterTerminal;

/** Project the full `TerminalMetadata` (which includes
 *  client-managed fields like themeName/canvasLayout/etc.) down to
 *  the agent-managed subset shipped over the wire. */
export function projectAgentMetadata(
  meta: TerminalMetadata,
): AgentTerminalMetadata {
  return {
    cwd: meta.cwd,
    git: meta.git,
    lastAgentCommand: meta.lastAgentCommand,
    lastActivityAt: meta.lastActivityAt,
    pr: meta.pr,
    agent: meta.agent,
    foreground: meta.foreground,
  };
}

/** Build the agent's surface router fragment + ctx. The fragment goes
 *  under the `surface` key in the agent's top-level oRPC router; the
 *  `ctx` is held by the aggregator so per-terminal updates publish
 *  through the framework's collection channels. */
export function buildAgentSurface() {
  return implementSurface(agentSurface, {
    // biome-ignore lint/suspicious/noExplicitAny: per-call typed via the framework's generic helper
    channel: <T>(_name: string): any => inMemoryChannel<T>(),

    collections: {
      terminalMetadata: {
        readAll: () => {
          const map = new Map<string, AgentTerminalMetadata>();
          for (const [id, entry] of terminalEntries()) {
            map.set(id, projectAgentMetadata(entry.meta));
          }
          return map;
        },
        // `upsert` and `remove` here are framework-internal hooks. The
        // terminal registry IS the source of truth — the aggregator
        // calls `ctx.collections.terminalMetadata.upsert(id, projection)`
        // to publish, but the registry handles actual creation/deletion
        // through the terminal.spawn/kill procedures below. So these
        // are no-ops on persistence; the framework still fires the
        // perKeyBus.publish from inside the wrapped upsert, which is
        // what subscribers actually see.
        upsert: (_id, _value) => {
          // intentional no-op — see comment above
        },
        remove: (_id) => {
          // intentional no-op — see comment above
        },
      },
    },

    streams: {
      terminalData: {
        source: (input, signal) =>
          localBackend.terminalChannel(input.id, "data", signal),
      },
      terminalCommandRun: {
        source: (input, signal) =>
          localBackend.terminalChannel(input.id, "commandRun", signal),
      },
      terminalTitle: {
        source: (input, signal) =>
          localBackend.terminalChannel(input.id, "title", signal),
      },
      fsRepoChange: {
        source: (input, signal) =>
          localBackend.fs.subscribeRepoChange(input.repoPath, signal),
      },
      fsFileChange: {
        source: (input, signal) =>
          localBackend.fs.subscribeFileChange(
            input.repoPath,
            input.filePath,
            signal,
          ),
      },
    },

    procedures: {
      system: {
        heartbeat: async () => ({ ok: true as const }),
      },
      terminal: {
        spawn: async ({ input }) => {
          const handle = await localBackend.spawnPty({
            id: input.id,
            cwd: input.cwd,
            initialMetadata: input.initialMetadata,
          });
          // Start aggregator after spawn so providers' subsequent
          // publishes flow through to the surface's terminalMetadata
          // channel. Started here (not in localBackend.spawnPty)
          // because the aggregator needs ctx, which we don't have
          // until implementSurface returns.
          startAgentMetadataAggregator(handle.id);
          return { id: handle.id };
        },
        kill: async ({ input }) => {
          stopAgentMetadataAggregator(input.id);
          return localBackend.killTerminal(input.id);
        },
        write: async ({ input }) => {
          const entry = getTerminal(input.id);
          if (!entry) {
            throw new ORPCError("NOT_FOUND", {
              message: `terminal ${input.id} not found on agent`,
            });
          }
          entry.handle.write(input.data);
        },
        resize: async ({ input }) => {
          const entry = getTerminal(input.id);
          if (!entry) {
            throw new ORPCError("NOT_FOUND", {
              message: `terminal ${input.id} not found on agent`,
            });
          }
          entry.handle.resize(input.cols, input.rows);
        },
        uploadFile: async ({ input }) => ({
          path: await localBackend.uploadFile(
            input.id,
            input.name,
            input.base64Data,
          ),
        }),
      },
      fs: {
        listAll: async ({ input }) => ({
          paths: await localBackend.fs.listAll(input.repoPath),
        }),
        readFile: async ({ input }) => {
          const result = await localBackend.fs.readFile(
            input.repoPath,
            input.filePath,
          );
          return { kind: "text" as const, ...result };
        },
      },
      git: {
        getDiff: async ({ input }) =>
          localBackend.git.getDiff(
            input.repoPath,
            input.filePath,
            input.mode,
            input.oldPath,
          ),
        getStatus: async ({ input }) =>
          localBackend.git.getStatus(input.repoPath, input.mode),
      },
    },
  });
}

// ── Per-terminal metadata aggregator ──────────────────────────────────

/** Holds the ctx + active aggregator AbortControllers. ctx is set once
 *  by `setAgentSurfaceCtx` after implementSurface returns. */
interface AggregatorState {
  ctx: ReturnType<typeof buildAgentSurface>["ctx"] | null;
  active: Map<string, AbortController>;
}
const state: AggregatorState = { ctx: null, active: new Map() };

/** Called by `agent.ts` after constructing the surface to inject ctx
 *  into the aggregator. */
export function setAgentSurfaceCtx(
  ctx: ReturnType<typeof buildAgentSurface>["ctx"],
): void {
  state.ctx = ctx;
}

/** Subscribe to the legacy `terminalChannels` for `id` and republish
 *  the aggregated `AgentTerminalMetadata` projection whenever any of
 *  them updates. The aggregator owns one AbortController per terminal;
 *  `stopAgentMetadataAggregator(id)` cleans up. */
export function startAgentMetadataAggregator(id: string): void {
  if (state.active.has(id)) return;
  if (!state.ctx) {
    log.warn({ id }, "agent-surface: aggregator started before ctx set");
    return;
  }
  const ctrl = new AbortController();
  state.active.set(id, ctrl);

  const publish = (): void => {
    const entry = getTerminal(id);
    if (!entry) return;
    state.ctx?.collections.terminalMetadata.upsert(
      id,
      projectAgentMetadata(entry.meta),
    );
  };

  // Initial publish — gets the collection seeded with the current
  // projection so subscribers' first snapshot reflects state at
  // aggregator-start time.
  publish();

  // Subscribe to each per-terminal channel and republish on any
  // event. The publishes all flow through one collection channel,
  // coalescing the 8-channel firehose into one snapshot stream.
  const subscribeKinds = [
    "cwd",
    "title",
    "git",
    "commandRun",
    "agent",
    "pr",
    "foreground",
  ] as const;
  for (const kind of subscribeKinds) {
    terminalChannels[kind](id).consume({
      onEvent: publish,
      onError: (err) =>
        log.warn({ id, kind, err }, "agent-surface: aggregator consume error"),
    });
  }
  // The AbortController doesn't currently tear down the consumers —
  // each terminalChannel.consume returns its own cleanup. For the
  // first migration cut, the publisher's MemoryPublisher just keeps
  // them around until process exit, which is fine because the agent
  // process dies with its parent's stdio anyway. A future tightening
  // can wire ctrl.signal through.
  log.info({ id }, "agent-surface: aggregator started");
}

/** Stop the aggregator for `id`. */
export function stopAgentMetadataAggregator(id: string): void {
  const ctrl = state.active.get(id);
  if (!ctrl) return;
  ctrl.abort();
  state.active.delete(id);
  state.ctx?.collections.terminalMetadata.remove(id);
  log.info({ id }, "agent-surface: aggregator stopped");
}
