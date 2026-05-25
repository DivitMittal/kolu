/** Single source for the canonical dock row order.
 *
 *  Three callsites previously ran their own `rankDockRows(...)` against
 *  `useTerminalStore` + `useStaleCheck`: desktop `Dock`, `MobileDockDrawer`,
 *  and `App.tsx`'s `dockOrderedIds` (which powers `Cmd+1..9`). The
 *  triplication invited exactly the lie `dockRowRanking.ts:5-12` was
 *  written to prevent — a keystroke targeting a different row than the
 *  dock paints. This singleton forces all three to agree by construction.
 *
 *  Outputs are layered:
 *  - `ranked` — bucket-classified, recency-sorted flat list, the raw
 *    `rankDockRows` output (kept exposed for tests / future callers).
 *  - `tree` — `ranked` projected into the repo→branch hierarchy that
 *    desktop and mobile render.
 *  - `ids` — depth-first walk of terminal IDs through `tree`. This is
 *    the `Cmd+1..9` target list; folded groups still contribute their
 *    children so the keystroke targets the Nth terminal regardless of
 *    fold state.
 *
 *  Cached via `createRoot` so a single set of reactive owners survives
 *  every consumer's lifecycle — same pattern as `useTerminalStore`. */

import { type Accessor, createMemo, createRoot } from "solid-js";
import type { TerminalId } from "kolu-common/surface";
import { useStaleCheck } from "../../terminal/staleness";
import { useTerminalStore } from "../../terminal/useTerminalStore";
import {
  type DockTreeNode,
  buildDockTree,
  flattenTerminalIds,
} from "./dockTree";
import { type RankedDockRow, rankDockRows } from "./dockRowRanking";

type DockOrder = {
  ranked: Accessor<RankedDockRow[]>;
  tree: Accessor<DockTreeNode[]>;
  ids: Accessor<TerminalId[]>;
};

function init(): DockOrder {
  const store = useTerminalStore();
  const isStale = useStaleCheck();
  const ranked = createMemo(() =>
    rankDockRows(store.terminalIds(), store.getMetadata, isStale),
  );
  const tree = createMemo(() => buildDockTree(ranked(), store.getDisplayInfo));
  const ids = createMemo(() => flattenTerminalIds(tree()));
  return { ranked, tree, ids };
}

let cached: DockOrder | undefined;

export function useDockOrder(): DockOrder {
  if (!cached) cached = createRoot(() => init());
  return cached;
}
