/**
 * oRPC router built from `surface.implement` — one declarative call wires
 * every cell, collection, stream, event, and imperative procedure declared
 * in `common/surface.ts`.
 *
 * The surface owns publish channels for cells and collections (channel
 * names derived from the surface key). Consumer-supplied `upsert`/`remove`
 * stay persistence-only; the framework wraps them so every change
 * broadcasts through the surface's channels. Imperative procedures get a
 * typed `ctx` (`ctx.collections.notes.upsert(...)`) so cross-descriptor
 * publishes route through the same channels.
 */

import { implementSurface, publisherChannel } from "@kolu/surface/server";
import { surface } from "../common/surface";
import {
  allNotes,
  autosaveChannel,
  getPrefs,
  newNoteId,
  publisher,
  removeNote,
  setPrefs,
  upsertNote,
} from "./store";
import { getWorker } from "./worker-client";

const { router: surfaceRouter } = implementSurface(surface, {
  channel: <T>(name: string) => publisherChannel<T>(publisher, name),

  cells: {
    prefs: {
      // patch fn comes from `surface.cells.prefs.patch` on the spec —
      // server and client share one merge function, no duplicate import.
      store: { get: getPrefs, set: setPrefs },
    },
  },

  collections: {
    notes: {
      readAll: allNotes,
      upsert: (key, value) => {
        upsertNote(key, value);
        scheduleAutosave(value);
        // Push the new corpus to the search-index worker. Fire-and-
        // forget: search results lag one push for the briefest moment,
        // not a correctness concern in this example. A delta protocol
        // would scale better; the example keeps it simple.
        pushCorpusToWorker();
      },
      remove: (key) => {
        removeNote(key);
        pushCorpusToWorker();
      },
    },
  },

  streams: {
    search: {
      // Delegates to the search-index worker child process via
      // Surface-over-stdio. Each query spawns a fresh subscription that
      // runs once and closes — same shape as the inline implementation
      // that this replaced, but the actual index lookup happens in a
      // separate process. Demonstrates the framework's stdio link
      // adapter end-to-end and the subprocess-worker pattern that's
      // its headline user benefit.
      source: async function* (input) {
        const worker = getWorker();
        const it = await worker.surface.search.get(input);
        for await (const result of it) yield result;
      },
    },
  },

  events: {
    autosave: {
      // Per-note channel: each note id has its own subscribe stream.
      // Channel managed in store.ts (not surface-derived) so the publish
      // path inside scheduleAutosave can write to the same instance.
      source: (id, signal) => autosaveChannel(id).subscribe(signal),
    },
  },

  procedures: {
    notes: {
      // Imperative create — server assigns the id; the surface's wrapped
      // upsert publishes through the framework's note channels.
      create: async ({ input, ctx }) => {
        const id = newNoteId();
        const note = {
          id,
          title: input.title,
          body: "",
          updatedAt: Date.now(),
        };
        ctx.collections.notes.upsert(id, note);
        return note;
      },
    },
  },
});

export const appRouter = surfaceRouter;

/** Snapshot-replace the worker's index from the current notes corpus.
 *  Debounced one tick so a batch of synchronous upserts (e.g. test
 *  fixtures) results in one push, not N. */
let pushPending = false;
function pushCorpusToWorker(): void {
  if (pushPending) return;
  pushPending = true;
  queueMicrotask(() => {
    pushPending = false;
    const snapshot = Array.from(allNotes().values()).map(
      ({ id, title, body }) => ({
        id,
        title,
        body,
      }),
    );
    void getWorker()
      .surface.index.update({ notes: snapshot })
      .catch((err: unknown) => {
        process.stderr.write(
          `[server] worker.index.update failed: ${String(err)}\n`,
        );
      });
  });
}

// Initial push at boot — populate the worker with the seed `Welcome`
// note (and any persistence-loaded state).
pushCorpusToWorker();

// ── Helpers (autosave debounce) ────────────────────────────────────────

/** Debounced autosave fire — coalesces rapid edits into one event.
 *  Publishes to `autosaveChannel` (managed in store.ts), which the
 *  surface's `events.autosave.source` subscribes to. */
const pendingAutosaves = new Map<string, ReturnType<typeof setTimeout>>();
function scheduleAutosave(note: { id: string; title: string }): void {
  const existing = pendingAutosaves.get(note.id);
  if (existing) clearTimeout(existing);
  pendingAutosaves.set(
    note.id,
    setTimeout(() => {
      pendingAutosaves.delete(note.id);
      autosaveChannel(note.id).publish({
        noteId: note.id,
        noteTitle: note.title,
        savedAt: Date.now(),
      });
    }, 500),
  );
}
