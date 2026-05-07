import type { TerminalId } from "kolu-common/surface";
import type { GitInfo } from "kolu-git/schemas";
import type { TileLayout } from "./TileLayout";
import { DEFAULT_TILE_H, DEFAULT_TILE_W } from "./tilePlacement";
import { GRID_SIZE, snapToGrid } from "./viewport/transforms";

/** Terminal tile input for repo-island layout policy. */
export type RepoIslandTile = {
  id: TerminalId;
  group: string;
  layout?: TileLayout;
};

/** Snapshot needed to decide where a newly created terminal should appear. */
export type RepoIslandTerminalSnapshot = {
  id: TerminalId;
  cwd: string;
  git: GitInfo | null;
  group: string | undefined;
  layout?: TileLayout;
};

/** Tunables for arranging existing terminal tiles into repo islands. */
export type RepoIslandArrangeOptions = {
  tileGap?: number;
  groupGap?: number;
  groupJitter?: number;
  random?: () => number;
  originX?: number;
  originY?: number;
};

/** Inputs for placing one new terminal beside an existing repo island. */
export type NewTilePlacementInput = {
  cwd?: string;
  activeId: TerminalId | null;
  terminals: RepoIslandTerminalSnapshot[];
};

const DEFAULT_TILE_GAP = GRID_SIZE;
// Keep repo islands visually distinct on the minimap; terminals keep their
// real widths, so inter-repo spacing needs to be tile-scale, not toolbar-scale.
const DEFAULT_GROUP_GAP = GRID_SIZE * 40;
const DEFAULT_GROUP_JITTER = GRID_SIZE * 8;
const MAX_PLACEMENT_ATTEMPTS = 50;

type Rect = { w: number; h: number };

type PackedGrid<T> = {
  items: { item: T; x: number; y: number }[];
  w: number;
  h: number;
};

type PlacementBounds = {
  minY: number;
  maxX: number;
};

/** Arrange all provided tiles into compact, separated repo islands. */
export function arrangeRepoIslands(
  tiles: RepoIslandTile[],
  options: RepoIslandArrangeOptions = {},
): Map<TerminalId, TileLayout> {
  if (tiles.length === 0) return new Map();

  const tileGap = options.tileGap ?? DEFAULT_TILE_GAP;
  const groupGap = options.groupGap ?? DEFAULT_GROUP_GAP;
  const random = options.random ?? Math.random;
  const originX = originFor(tiles, "x", options.originX);
  const originY = originFor(tiles, "y", options.originY);
  const groups = new Map<string, RepoIslandTile[]>();

  for (const tile of tiles) {
    const group = groups.get(tile.group);
    if (group) group.push(tile);
    else groups.set(tile.group, [tile]);
  }

  const clusters = [...groups.entries()].map(([group, groupTiles]) => ({
    group,
    ...arrangeCluster(groupTiles, tileGap),
  }));
  const groupJitter =
    clusters.length > 1 ? (options.groupJitter ?? DEFAULT_GROUP_JITTER) : 0;
  const clusterOffsets = packSquareGrid(clusters, groupGap, (cluster) => ({
    w: cluster.w,
    h: cluster.h,
  })).items;
  const result = new Map<TerminalId, TileLayout>();

  clusters.forEach((cluster, index) => {
    const offset = clusterOffsets[index] ?? { item: cluster, x: 0, y: 0 };
    const jitterX = jitterFor(groupJitter, random);
    const jitterY = jitterFor(groupJitter, random);
    for (const [id, layout] of cluster.layouts) {
      result.set(id, {
        ...layout,
        x: originX + offset.x + jitterX + layout.x,
        y: originY + offset.y + jitterY + layout.y,
      });
    }
  });

  return result;
}

/** Return an initial layout for a new terminal in a matching repo island. */
export function placeNewTileInRepoIsland({
  cwd,
  activeId,
  terminals,
}: NewTilePlacementInput): TileLayout | undefined {
  const targetGroup = targetGroupForCreate({ cwd, activeId, terminals });
  if (!targetGroup) return undefined;

  const groupLayouts = terminals.flatMap((terminal) =>
    terminal.group === targetGroup && terminal.layout ? [terminal.layout] : [],
  );
  const bounds = boundsOfLayouts(groupLayouts);
  if (!bounds) return undefined;

  const existingLayouts = terminals.flatMap((terminal) =>
    terminal.layout ? [terminal.layout] : [],
  );
  let candidate: TileLayout = {
    x: ceilToGrid(bounds.maxX + DEFAULT_TILE_GAP),
    y: snapToGrid(bounds.minY),
    w: DEFAULT_TILE_W,
    h: DEFAULT_TILE_H,
  };
  const verticalStep = ceilToGrid(DEFAULT_TILE_H + DEFAULT_TILE_GAP);

  for (let attempt = 0; attempt < MAX_PLACEMENT_ATTEMPTS; attempt++) {
    if (!existingLayouts.some((layout) => layoutsOverlap(candidate, layout))) {
      return candidate;
    }

    candidate = {
      ...candidate,
      y: snapToGrid(candidate.y + verticalStep),
    };
  }

  return undefined;
}

function targetGroupForCreate({
  cwd,
  activeId,
  terminals,
}: NewTilePlacementInput): string | undefined {
  const active = terminals.find((terminal) => terminal.id === activeId);
  const targetCwd = cwd ?? active?.cwd;
  if (!targetCwd) return active?.group;
  if (active?.cwd === targetCwd) return active.group;

  const exact = terminals.find(
    (terminal) => terminal.group && terminal.cwd === targetCwd,
  );
  if (exact) return exact.group;

  return mostSpecificGitMatch(terminals, targetCwd)?.group;
}

function arrangeCluster(
  tiles: RepoIslandTile[],
  tileGap: number,
): {
  layouts: Map<TerminalId, TileLayout>;
  w: number;
  h: number;
} {
  const packed = packSquareGrid(
    tiles.map((tile) => ({ tile, layout: fallbackLayout(tile) })),
    tileGap,
    ({ layout }) => layout,
  );
  const arranged = new Map<TerminalId, TileLayout>();

  for (const { item, x, y } of packed.items) {
    const { tile, layout } = item;
    arranged.set(tile.id, {
      x,
      y,
      w: layout.w,
      h: layout.h,
    });
  }

  return {
    layouts: arranged,
    w: packed.w,
    h: packed.h,
  };
}

function fallbackLayout(tile: RepoIslandTile): TileLayout {
  return tile.layout ?? { x: 0, y: 0, w: DEFAULT_TILE_W, h: DEFAULT_TILE_H };
}

function packSquareGrid<T>(
  items: T[],
  gap: number,
  measure: (item: T) => Rect,
): PackedGrid<T> {
  if (items.length === 0) return { items: [], w: 0, h: 0 };
  const columns = Math.ceil(Math.sqrt(items.length));
  const rows = Math.ceil(items.length / columns);
  const colWidths = Array.from({ length: columns }, () => 0);
  const rowHeights = Array.from({ length: rows }, () => 0);

  items.forEach((item, index) => {
    const { w, h } = measure(item);
    const col = index % columns;
    const row = Math.floor(index / columns);
    colWidths[col] = Math.max(colWidths[col] ?? 0, w);
    rowHeights[row] = Math.max(rowHeights[row] ?? 0, h);
  });

  const colOffsets = gridTracks(colWidths, gap);
  const rowOffsets = gridTracks(rowHeights, gap);
  return {
    items: items.map((item, index) => ({
      item,
      x: colOffsets[index % columns] ?? 0,
      y: rowOffsets[Math.floor(index / columns)] ?? 0,
    })),
    w: extentFromOffsets(colOffsets, colWidths),
    h: extentFromOffsets(rowOffsets, rowHeights),
  };
}

function gridTracks(lengths: number[], gap: number): number[] {
  const offsets: number[] = [];
  let cursor = 0;
  for (const length of lengths) {
    offsets.push(cursor);
    cursor = ceilToGrid(cursor + length + gap);
  }
  return offsets;
}

function boundsOfLayouts(layouts: TileLayout[]): PlacementBounds | undefined {
  if (layouts.length === 0) return undefined;
  return {
    minY: Math.min(...layouts.map((layout) => layout.y)),
    maxX: Math.max(...layouts.map((layout) => layout.x + layout.w)),
  };
}

function extentFromOffsets(offsets: number[], lengths: number[]): number {
  if (offsets.length === 0) return 0;
  const last = offsets.length - 1;
  return (offsets[last] ?? 0) + (lengths[last] ?? 0);
}

function ceilToGrid(value: number): number {
  return Math.ceil(value / GRID_SIZE) * GRID_SIZE;
}

function jitterFor(maxJitter: number, random: () => number): number {
  const steps = Math.floor(maxJitter / GRID_SIZE);
  if (steps <= 0) return 0;
  return Math.min(steps, Math.floor(random() * (steps + 1))) * GRID_SIZE;
}

function originFor(
  tiles: RepoIslandTile[],
  axis: "x" | "y",
  explicit: number | undefined,
): number {
  if (explicit !== undefined) return explicit;
  const values = tiles.map((tile) => fallbackLayout(tile)[axis]);
  return values.length > 0 ? Math.min(...values) : 0;
}

function layoutsOverlap(a: TileLayout, b: TileLayout): boolean {
  return (
    a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y
  );
}

function mostSpecificGitMatch(
  terminals: RepoIslandTerminalSnapshot[],
  cwd: string,
): RepoIslandTerminalSnapshot | undefined {
  let best:
    | { terminal: RepoIslandTerminalSnapshot; matchingRootLength: number }
    | undefined;

  for (const terminal of terminals) {
    if (!terminal.group) continue;
    const matchingRootLength = longestMatchingGitRootLength(terminal.git, cwd);
    if (matchingRootLength === undefined) continue;
    if (!best || matchingRootLength > best.matchingRootLength) {
      best = { terminal, matchingRootLength };
    }
  }

  return best?.terminal;
}

function longestMatchingGitRootLength(
  git: GitInfo | null,
  cwd: string,
): number | undefined {
  if (!git) return undefined;
  const matches = [git.repoRoot, git.mainRepoRoot, git.worktreePath].filter(
    (root) => pathContains(root, cwd),
  );
  if (matches.length === 0) return undefined;
  return Math.max(...matches.map((root) => root.length));
}

function pathContains(root: string, cwd: string): boolean {
  if (!root) return false;
  if (root === "/") return cwd === "/";
  const prefix = root.endsWith("/") ? root : `${root}/`;
  return cwd === root || cwd.startsWith(prefix);
}
