import type { TerminalId } from "kolu-common/surface";
import type { TileLayout } from "./TileLayout";
import {
  arrangeRepoIslands,
  type RepoIslandArrangeOptions,
  type RepoIslandTile,
} from "./repoIslandPlacement";

/** Terminal tile input consumed by the canvas auto-arrange command. */
export type AutoArrangeTile = RepoIslandTile;

/** Options for the canvas auto-arrange command. */
export type AutoArrangeOptions = RepoIslandArrangeOptions;

/** Arrange live terminal tiles into repo islands.
 *
 * Each repo group becomes a compact square-ish grid; repo islands themselves
 * get a wider, random stagger so the minimap still reads as distinct islands
 * instead of one tiled mass. Width and height are preserved for every tile —
 * the command only rewrites x/y.
 */
export function arrangeByRepo(
  tiles: AutoArrangeTile[],
  options: AutoArrangeOptions = {},
): Map<TerminalId, TileLayout> {
  return arrangeRepoIslands(tiles, options);
}
