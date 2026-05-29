/**
 * `agentSurface` — the typed wire shape the kolu PTY-host **agent** serves.
 *
 * The agent is the daemon kolu-server spawns (`kolu --stdio`, over a unix
 * socket today; the same shape rides ssh stdio for R-2's remote agent).
 * Since #951 **R4b** the agent owns `@kolu/pty-host` **and** the per-terminal
 * provider DAG (`terminalBackend/providers.ts`) and emits an enriched
 * per-terminal metadata stream. R4c (this contract) is the *encoding* of that
 * already-drawn boundary onto a socket — not a new boundary.
 *
 * Two streams carry everything:
 *
 *   - `terminalAttach` — per-terminal PTY output, snapshot-then-delta. First
 *     yield is `{kind:"snapshot", data}` (the serialized `@xterm/headless`
 *     buffer at attach time), then `{kind:"delta", data}` for live output.
 *   - `agentMetadata` — the single multiplexed `AgentMetadataEvent` stream
 *     (the in-process R4b `Channel<AgentMetadataEvent>`, now wire-shaped).
 *     The daemon yields a current-state *snapshot* (one `metadataPersisted` +
 *     one `metadataLive` per live terminal) before live deltas, so a
 *     reconnecting kolu-server gets *warm* metadata without a re-detection
 *     storm. The `metadataPersisted`/`metadataLive` discriminator carries the
 *     `terminals:dirty` autosave fence across the wire on the event TYPE —
 *     exactly as in-process.
 *
 * Contract version. Bumped on the *wire shape*, not the kolu binary hash, so
 * the long-lived daemon survives most kolu upgrades. kolu-server decides
 * compatibility via `isAgentContractCompatible`; a mismatch is degraded mode.
 */

import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import { z } from "zod";
import {
  LiveTerminalFieldsSchema,
  ServerPersistedTerminalFieldsSchema,
  TerminalIdSchema,
  TerminalServerMetadataSchema,
} from "./surface.ts";

/** The wire-shape `major.minor` version this build serves and expects.
 *  Bumped only when `agentSurface` itself changes shape: minor for additive
 *  changes (new optional field / procedure / stream), major for breaking
 *  ones. Internal refactors (the kolu binary, the PTY engine) do NOT bump it
 *  — that's the whole point, so the daemon survives most kolu upgrades.
 *  Compatibility is decided by `isAgentContractCompatible`. */
export const AGENT_CONTRACT_VERSION = "1.0";

/** Whether a daemon reporting `daemonVersion` is wire-compatible with a
 *  kolu-server built against `expected` (both `major.minor`). Compatible when
 *  the majors match and the daemon's minor is >= ours — additive minor bumps
 *  stay backwards-compatible; a major mismatch is degraded mode. Tolerates a
 *  trailing patch/prerelease suffix on either side (only `major.minor` is
 *  load-bearing). */
export function isAgentContractCompatible(
  daemonVersion: string,
  expected: string,
): boolean {
  const parse = (v: string): [number, number] | null => {
    const m = /^(\d+)\.(\d+)/.exec(v);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const a = parse(daemonVersion);
  const b = parse(expected);
  if (!a || !b) return false;
  return a[0] === b[0] && a[1] >= b[1];
}

/**
 * The wire form of the in-process R4b `AgentMetadataEvent` — one multiplexed
 * stream of per-terminal metadata + lifecycle, tagged by id.
 *
 * The `metadataPersisted` / `metadataLive` split is the autosave fence: a
 * persisted-field change rides `metadataPersisted` (kolu-server fires
 * `terminals:dirty`); a live-only change rides `metadataLive` (it must NOT).
 * Each carries only its half of the partition, so the consumer applies it
 * with one `Object.assign`. `recentRepo`/`recentAgent` feed the kolu-server
 * activity feed (a cross-terminal aggregate the agent can't own once remote).
 * `exit` fires on a *natural* PTY exit only — an explicit kill does not emit
 * one (the kill RPC's own response drives client cleanup).
 */
export const AgentMetadataEventSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("metadataPersisted"),
    id: TerminalIdSchema,
    fields: ServerPersistedTerminalFieldsSchema,
  }),
  z.object({
    kind: z.literal("metadataLive"),
    id: TerminalIdSchema,
    fields: LiveTerminalFieldsSchema,
  }),
  z.object({
    kind: z.literal("recentRepo"),
    root: z.string(),
    name: z.string(),
  }),
  z.object({ kind: z.literal("recentAgent"), command: z.string() }),
  z.object({
    kind: z.literal("exit"),
    id: TerminalIdSchema,
    exitCode: z.number().int(),
  }),
]);

export type AgentMetadataEvent = z.infer<typeof AgentMetadataEventSchema>;

const TerminalSpawnInputSchema = z.object({
  /** Caller-supplied PTY id. kolu-server mints the terminal id and passes it
   *  here so the daemon's PTY id == kolu-server's terminal id — this is what
   *  makes reattach-by-id work across kolu-server restart. */
  id: TerminalIdSchema.optional(),
  cwd: z.string().optional(),
  cols: z.number().int().positive().optional(),
  rows: z.number().int().positive().optional(),
  scrollback: z.number().int().positive().optional(),
  /** Restored `lastActivityAt` from a saved session — seeds the agent's
   *  recency clock so re-detecting a resumed agent doesn't bump it to "now".
   *  (In-process this was `restoredActivityAt` on `Agent.spawn`.) */
  restoredActivityAt: z.number().optional(),
});

const TerminalSpawnOutputSchema = z.object({
  id: TerminalIdSchema,
  pid: z.number().int(),
  /** The agent's initial server-visible metadata for the terminal, so
   *  kolu-server can register its entry synchronously before the first
   *  `agentMetadata` delta arrives. */
  meta: TerminalServerMetadataSchema,
});

const TerminalIdInputSchema = z.object({ id: TerminalIdSchema });

const TerminalWriteInputSchema = z.object({
  id: TerminalIdSchema,
  data: z.string(),
});

const TerminalResizeInputSchema = z.object({
  id: TerminalIdSchema,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});

/** A PTY the daemon still owns. The minimal shape kolu-server needs to
 *  reattach by id across its own restart. */
const TerminalListEntrySchema = z.object({
  id: TerminalIdSchema,
  pid: z.number().int(),
  cwd: z.string(),
  lastActivity: z.number(),
});

const TerminalDataMsgSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("snapshot"), data: z.string() }),
  z.object({ kind: z.literal("delta"), data: z.string() }),
]);

const SystemVersionOutputSchema = z.object({
  contractVersion: z.string(),
  pkgVersion: z.string(),
  pid: z.number().int(),
  startedAt: z.number(),
});

const SystemHeartbeatOutputSchema = z.object({ ts: z.number() });

export const agentSurface = defineSurface({
  streams: {
    /** Per-terminal output stream — snapshot then live deltas. */
    terminalAttach: {
      inputSchema: TerminalIdInputSchema,
      outputSchema: TerminalDataMsgSchema,
    },
    /** The single multiplexed metadata + lifecycle stream. Snapshot
     *  (current per-terminal metadata) then live deltas. */
    agentMetadata: {
      inputSchema: z.object({}),
      outputSchema: AgentMetadataEventSchema,
    },
  },
  procedures: {
    terminal: {
      spawn: {
        input: TerminalSpawnInputSchema,
        output: TerminalSpawnOutputSchema,
      },
      kill: {
        input: TerminalIdInputSchema,
        output: z.object({ ok: z.boolean() }),
      },
      killAll: {
        input: z.object({}),
        output: z.object({ killed: z.number().int() }),
      },
      write: {
        input: TerminalWriteInputSchema,
        output: z.object({ ok: z.boolean() }),
      },
      resize: {
        input: TerminalResizeInputSchema,
        output: z.object({ ok: z.boolean() }),
      },
      list: {
        input: z.object({}),
        output: z.object({ entries: z.array(TerminalListEntrySchema) }),
      },
      getScreenState: {
        input: TerminalIdInputSchema,
        output: z.object({ data: z.string() }),
      },
      getScreenText: {
        input: z.object({
          id: TerminalIdSchema,
          startLine: z.number().int().optional(),
          endLine: z.number().int().optional(),
        }),
        output: z.object({ text: z.string() }),
      },
    },
    system: {
      version: { input: z.object({}), output: SystemVersionOutputSchema },
      heartbeat: { input: z.object({}), output: SystemHeartbeatOutputSchema },
    },
  },
});

export type AgentSurface = SurfaceTypes<typeof agentSurface.spec>;
export type AgentTerminalListEntry = z.infer<typeof TerminalListEntrySchema>;
export type AgentTerminalDataMsg = z.infer<typeof TerminalDataMsgSchema>;
export type AgentSystemVersion = z.infer<typeof SystemVersionOutputSchema>;
