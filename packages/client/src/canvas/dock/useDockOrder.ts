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
 *  - `tree` — the repo→branch hierarchy that desktop and mobile render.
 *  - `ids` — depth-first walk of terminal IDs through `tree`. This is
 *    the `Cmd+1..9` target list; folded groups still contribute their
 *    children so the keystroke targets the Nth terminal regardless of
 *    fold state.
 *
 *  `ranked` (the raw `rankDockRows` output) lives as an internal memo
 *  feeding `tree`; it isn't exposed because every consumer either reads
 *  `tree` (renderers) or `ids` (the keyboard shortcut). Direct
 *  `rankDockRows` callers (e.g. unit tests) import the function directly
 *  rather than reaching through here.
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
import { rankDockRows } from "./dockRowRanking";

type DockOrder = {
  tree: Accessor<DockTreeNode[]>;
  ids: Accessor<TerminalId[]>;
};

function init(): DockOrder {
  const store = useTerminalStore();
  const isStale = useStaleCheck();
  // Hide parked terminals entirely instead of dimming them inline.
  // Before auto-grouping, the dimmed parked row was the visual signal
  // "this terminal still exists but is past the activity window"; with
  // repo→branch headers carrying the organization, leaving parked rows
  // in just adds noise to every branch sub-section. The activity-window
  // selector now controls visibility — picking "Show all terminals"
  // returns `null` from `activityWindowThresholdMs()`, `isStale` then
  // returns false for every row, and no row is bucketed as parked.
  const ranked = createMemo(() =>
    rankDockRows(store.terminalIds(), store.getMetadata, isStale).filter(
      (row) => row.bucket !== "parked",
    ),
  );
  const tree = createMemo(() => buildDockTree(ranked(), store.getDisplayInfo));
  const ids = createMemo(() => flattenTerminalIds(tree()));
  return { tree, ids };
}

let cached: DockOrder | undefined;

export function useDockOrder(): DockOrder {
  if (!cached) cached = createRoot(() => init());
  return cached;
}
