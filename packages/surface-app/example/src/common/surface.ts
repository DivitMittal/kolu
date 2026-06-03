/**
 * The app's reactive surface — one cell, composed from surface-app's build
 * identity fragment. A real app spreads its own cells/collections/streams
 * alongside `...buildInfo.cells`.
 */

import { defineSurface } from "@kolu/surface/define";
import { buildInfo } from "@kolu/surface-app/surface";

export const surface = defineSurface({
  cells: {
    ...buildInfo.cells,
  },
});
