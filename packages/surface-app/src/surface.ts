/**
 * @kolu/surface-app/surface — build identity as a composable surface fragment.
 *
 * "What build is the server?" is reactive server state, so it rides surface as a
 * `buildInfo` cell. The default exposes just `{ commit }`; an app composes its
 * `cells` into its own `defineSurface(...)`. Build identity is the one thing apps
 * vary — so it's an INTERFACE: `defineBuildInfo` lets kolu add a pty-host axis
 * while drishti takes the default, and both carry the same `isStale` predicate.
 */

import { z } from "zod";
import { clientIsStale } from "./index.ts";

/** The minimum build identity: the deployed commit. Extend it via `defineBuildInfo`. */
export interface BuildInfo {
  commit: string;
}

/** A composable build-identity fragment: a `cells` map to spread into your
 *  `defineSurface({ cells: { ...buildInfo.cells } })`, plus the `isStale`
 *  predicate the UI reads. */
export interface BuildInfoDef<T extends BuildInfo = BuildInfo> {
  cells: { buildInfo: { schema: z.ZodType<T>; default: T } };
  isStale: (server: T, clientCommit: string | undefined) => boolean;
}

/** Define a build-identity fragment. The default `isStale` is the pure,
 *  clean-ref-guarded commit comparison; extend `schema` (and `isStale`) to add
 *  more axes — e.g. kolu's pty-host divergence. */
export function defineBuildInfo<T extends BuildInfo>(opts: {
  schema: z.ZodType<T>;
  default: T;
  isStale?: (server: T, clientCommit: string | undefined) => boolean;
}): BuildInfoDef<T> {
  return {
    cells: { buildInfo: { schema: opts.schema, default: opts.default } },
    isStale:
      opts.isStale ??
      ((server, clientCommit) => clientIsStale(server.commit, clientCommit)),
  };
}

/** The default build identity: `{ commit }`. drishti uses exactly this. */
export const buildInfo: BuildInfoDef = defineBuildInfo({
  schema: z.object({ commit: z.string() }),
  default: { commit: "" },
});
