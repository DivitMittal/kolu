import type { TerminalId } from "kolu-common/surface";
import type { TileLayout } from "./TileLayout";
import { DEFAULT_TILE_H, DEFAULT_TILE_W } from "./tilePlacement";
import { GRID_SIZE } from "./viewport/transforms";

export type AutoArrangeTile = {
  id: TerminalId;
  group: string;
  layout?: TileLayout;
};

export type AutoArrangeOptions = {
  tileGap?: number;
  groupGap?: number;
  originX?: number;
  originY?: number;
};

const DEFAULT_TILE_GAP = GRID_SIZE * 2;
const DEFAULT_GROUP_GAP = GRID_SIZE * 4;

type Rect = { w: number; h: number };

type PackedGrid<T> = {
  items: { item: T; x: number; y: number }[];
  w: number;
  h: number;
};

function fallbackLayout(tile: AutoArrangeTile): TileLayout {
  return tile.layout ?? { x: 0, y: 0, w: DEFAULT_TILE_W, h: DEFAULT_TILE_H };
}

function ceilToGrid(value: number): number {
  return Math.ceil(value / GRID_SIZE) * GRID_SIZE;
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

function extentFromOffsets(offsets: number[], lengths: number[]): number {
  if (offsets.length === 0) return 0;
  const last = offsets.length - 1;
  return (offsets[last] ?? 0) + (lengths[last] ?? 0);
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

function arrangeCluster(
  tiles: AutoArrangeTile[],
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

function originFor(
  tiles: AutoArrangeTile[],
  axis: "x" | "y",
  explicit: number | undefined,
): number {
  if (explicit !== undefined) return explicit;
  const values = tiles.map((tile) => fallbackLayout(tile)[axis]);
  return values.length > 0 ? Math.min(...values) : 0;
}

/** Arrange live terminal tiles into repo clusters.
 *
 * Each repo group becomes a small square-ish grid; repo groups themselves are
 * then packed into a square-ish outer grid. Width and height are preserved for
 * every tile — the command only rewrites x/y.
 */
export function arrangeByRepo(
  tiles: AutoArrangeTile[],
  options: AutoArrangeOptions = {},
): Map<TerminalId, TileLayout> {
  if (tiles.length === 0) return new Map();

  const tileGap = options.tileGap ?? DEFAULT_TILE_GAP;
  const groupGap = options.groupGap ?? DEFAULT_GROUP_GAP;
  const originX = originFor(tiles, "x", options.originX);
  const originY = originFor(tiles, "y", options.originY);
  const groups = new Map<string, AutoArrangeTile[]>();

  for (const tile of tiles) {
    const group = groups.get(tile.group);
    if (group) group.push(tile);
    else groups.set(tile.group, [tile]);
  }

  const clusters = [...groups.values()].map((group) =>
    arrangeCluster(group, tileGap),
  );
  const clusterOffsets = packSquareGrid(clusters, groupGap, (cluster) => ({
    w: cluster.w,
    h: cluster.h,
  })).items;
  const result = new Map<TerminalId, TileLayout>();

  clusters.forEach((cluster, index) => {
    const offset = clusterOffsets[index] ?? { item: cluster, x: 0, y: 0 };
    for (const [id, layout] of cluster.layouts) {
      result.set(id, {
        ...layout,
        x: originX + offset.x + layout.x,
        y: originY + offset.y + layout.y,
      });
    }
  });

  return result;
}
