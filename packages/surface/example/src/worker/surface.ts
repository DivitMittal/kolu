/**
 * Worker surface — the typed reactive surface the search-index worker
 * child process exposes over stdio.
 *
 * Two primitives the parent consumes:
 *
 *   - `stats` cell — current indexer health (PID, indexed-note count,
 *     uptime). Yields a snapshot on every connect; the parent re-renders
 *     a footer chip showing "Indexed by worker pid X" so the user can
 *     SEE the worker doing real work.
 *
 *   - `search` stream — given a query, yields a list of matching note
 *     ids and the query echoed back. Snapshot-then-static (single
 *     yield per query) — the parent re-subscribes whenever the query
 *     changes.
 *
 * One imperative procedure:
 *
 *   - `updateIndex` — the parent pushes the current notes corpus on
 *     boot and after every upsert/delete. The worker rebuilds its
 *     inverted index from this snapshot. (A delta protocol would be
 *     cheaper for large corpora; the example keeps it simple.)
 *
 * Design notes:
 *
 *   - The worker's surface is independent from the parent's. The
 *     parent's `search` stream (in `../common/surface.ts`) is the
 *     browser-facing wire shape; this is the worker-facing one. The
 *     parent's handler delegates to this surface.
 *   - All schemas are local — the worker is the source of truth for
 *     its own contract. Keeps the worker package self-contained;
 *     anyone could reuse the search-index pattern with a different
 *     parent surface by importing this contract.
 */

import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import { z } from "zod";

const NoteIdSchema = z.string();

const NoteSchema = z.object({
  id: NoteIdSchema,
  title: z.string(),
  body: z.string(),
});

export const workerSurface = defineSurface({
  cells: {
    stats: {
      schema: z.object({
        pid: z.number(),
        indexed: z.number(),
        startedAt: z.number(),
      }),
      default: { pid: 0, indexed: 0, startedAt: 0 },
    },
  },
  streams: {
    search: {
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({
        matches: z.array(NoteIdSchema),
        query: z.string(),
      }),
    },
  },
  procedures: {
    index: {
      update: {
        input: z.object({ notes: z.array(NoteSchema) }),
        // void return — fire-and-forget snapshot replace.
      },
    },
  },
});

type WS = SurfaceTypes<typeof workerSurface.spec>;
export type WorkerStats = WS["cells"]["stats"]["Value"];
export type SearchInput = WS["streams"]["search"]["Input"];
export type SearchOutput = WS["streams"]["search"]["Output"];
