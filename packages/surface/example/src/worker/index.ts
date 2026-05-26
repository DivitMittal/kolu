/**
 * Search-index worker entry point.
 *
 * Spawned as a child process of the example server. Serves the worker
 * surface (`./surface.ts`) over stdio, owns an inverted index of notes,
 * and answers searches in sub-millisecond time regardless of how many
 * notes the parent has accumulated.
 *
 * Demonstrates the @kolu/surface stdio-link pattern end-to-end:
 *
 *  - `serveOverStdio` from `@kolu/surface/peer-server` pumps the
 *    process's stdin/stdout through `ServerPeer`.
 *  - `implementSurface` from `@kolu/surface/server` binds the worker's
 *    cells/streams/procedures to in-memory state.
 *  - `inMemoryChannel` + `inMemoryStore` from the same package handle
 *    persistence and pub/sub within this process.
 *
 * Process logs MUST NOT go to stdout (it IS the oRPC channel). Any log
 * output goes to stderr. The parent surfaces stderr as worker logs.
 *
 * Lifecycle: the parent process owns the worker's lifecycle. When the
 * parent exits, stdin closes and `serveOverStdio` resolves; we exit 0.
 * No graceful shutdown beyond that — the worker is stateless modulo
 * the in-memory index, which is rebuilt on next start via the
 * parent's first `updateIndex` call.
 */

import { implement } from "@orpc/server";
import { defineSurface as _defineSurface } from "@kolu/surface/define"; // ensure side-effect-free package import works
import { serveOverStdio } from "@kolu/surface/peer-server";
import {
  implementSurface,
  inMemoryChannel,
  inMemoryStore,
} from "@kolu/surface/server";
import { workerSurface, type SearchOutput } from "./surface";

/** Inverted index: word → set of note ids containing it. Built from the
 *  parent's `index.update` snapshots. Plain Map + Set — sub-millisecond
 *  lookups, fine for the example's notes corpus. */
const index = new Map<string, Set<string>>();
/** Note id → indexable text. Kept so re-index can drop stale words on
 *  delete; also used to defensively echo body matches on partial-word
 *  queries. */
const corpus = new Map<string, string>();

const startedAt = Date.now();

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
}

function indexNote(id: string, title: string, body: string): void {
  const text = `${title} ${body}`;
  corpus.set(id, text.toLowerCase());
  for (const word of tokenize(text)) {
    let set = index.get(word);
    if (!set) {
      set = new Set();
      index.set(word, set);
    }
    set.add(id);
  }
}

function rebuildIndex(
  notes: { id: string; title: string; body: string }[],
): void {
  index.clear();
  corpus.clear();
  for (const n of notes) indexNote(n.id, n.title, n.body);
}

function search(query: string): SearchOutput {
  const q = query.trim().toLowerCase();
  if (!q) return { matches: [], query };
  const words = tokenize(q);
  if (words.length === 0) {
    // Fall back to substring scan over corpus — covers partial-word
    // queries that don't tokenize cleanly (e.g. trailing letters mid-
    // word).
    const matches: string[] = [];
    for (const [id, text] of corpus) {
      if (text.includes(q)) matches.push(id);
    }
    return { matches, query };
  }
  // Intersect posting lists for all words — AND semantics.
  let candidates: Set<string> | null = null;
  for (const word of words) {
    const posting = index.get(word);
    if (!posting) {
      // No matches if any word is absent. Also fall through to
      // substring scan for partial-word coverage.
      candidates = new Set();
      break;
    }
    if (candidates === null) {
      candidates = new Set(posting);
    } else {
      for (const id of candidates) {
        if (!posting.has(id)) candidates.delete(id);
      }
    }
  }
  const out = candidates ?? new Set<string>();
  // Augment with substring scan for partial-prefix typing — e.g. user
  // typed "wel" and "Welcome" should match even though "wel" isn't a
  // complete word in the index.
  if (q.length >= 2) {
    for (const [id, text] of corpus) {
      if (text.includes(q)) out.add(id);
    }
  }
  return { matches: Array.from(out), query };
}

// ── Wire up the worker's surface ───────────────────────────────────────

const statsStore = inMemoryStore<{
  pid: number;
  indexed: number;
  startedAt: number;
}>({
  pid: process.pid,
  indexed: 0,
  startedAt,
});
const statsBus = inMemoryChannel<{
  pid: number;
  indexed: number;
  startedAt: number;
}>();

const { router: routerFragment } = implementSurface(workerSurface, {
  // biome-ignore lint/suspicious/noExplicitAny: untyped framework channel factory
  channel: <T>(_name: string): any => inMemoryChannel<T>(),

  cells: {
    stats: {
      store: statsStore,
    },
  },

  streams: {
    search: {
      source: async function* (input) {
        yield search(input.query);
      },
    },
  },

  procedures: {
    index: {
      update: async ({ input, ctx }) => {
        rebuildIndex(input.notes);
        ctx.cells.stats.set({
          pid: process.pid,
          indexed: input.notes.length,
          startedAt,
        });
        // Also publish on the local stats bus so any direct subscribers
        // see the update (the framework's cell handler already does
        // this via `ctx.cells.stats.set` — explicit publish removed).
      },
    },
  },
});

// Silence unused-import warning while keeping the package's
// side-effect-free assertion intact.
void _defineSurface;
void statsBus;

// ── Serve on process stdin/stdout ──────────────────────────────────────

process.stderr.write(
  `[worker pid=${process.pid}] starting search-index worker\n`,
);

// Re-wrap the surface fragment as a proper top-level router so the
// stdio StandardRPCHandler walks paths from the root correctly.
// `implementSurface(...).router` returns `{ surface: <router> }` —
// useful when spread into a host's own `t.router({...})`, but the
// plain-object wrapper doesn't satisfy oRPC's "this is a router"
// invariants on its own.
const t = implement(workerSurface.contract);
// biome-ignore lint/suspicious/noExplicitAny: implement() returns a typed router; StandardRPCHandler accepts the broader oRPC Router shape.
const router = t.router(routerFragment as any);

process.stderr.write(
  `[worker pid=${process.pid}] router built; entries=${Object.keys(routerFragment.surface ?? {}).join(",")}\n`,
);

void serveOverStdio({
  router,
  onError: (err) => {
    process.stderr.write(`[worker pid=${process.pid}] error: ${String(err)}\n`);
  },
  onClose: () => {
    process.stderr.write(
      `[worker pid=${process.pid}] parent closed stdin; exiting\n`,
    );
    process.exit(0);
  },
}).then(() => {
  process.exit(0);
});
