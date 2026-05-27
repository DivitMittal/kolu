/**
 * Single dispatch point for "which backend handles this terminal".
 *
 * The resolver consolidates the only place in the server that
 * pattern-matches on `location.kind`. Every consumer downstream
 * (router, surface, terminal lifecycle) calls
 * `getTerminalBackendFor(location)` and then talks to the returned
 * backend object — never asking "is this local or remote?" itself.
 *
 * R-1 has only the local variant. R-2 will add `{ kind: "remote",
 * host: string }` and an inner branch on `host` that resolves to a
 * `RemoteTerminalBackend` per `HostSession`. R-2's
 * `getTerminalBackendForCreate({ parentId, location })` resolver lives
 * next to this one once it's written — sub-terminal inheritance reads
 * the parent's `meta.location` rather than trusting the create input,
 * which is the single place that needs to know "where do new
 * terminals end up".
 */

import type {
  TerminalBackend,
  TerminalLocation,
} from "kolu-common/terminalBackend";
import { localTerminalBackend } from "./local.ts";
import { RemoteTerminalBackend } from "./remote.ts";

const remoteBackends = new Map<string, RemoteTerminalBackend>();

export function getTerminalBackendFor(
  location: TerminalLocation,
): TerminalBackend {
  if (location.kind === "local") return localTerminalBackend;
  // Remote — one backend per host, sharing the underlying
  // `HostSession` (and therefore one ssh subprocess) across all
  // terminals on that host.
  let backend = remoteBackends.get(location.host);
  if (!backend) {
    backend = new RemoteTerminalBackend(location.host);
    remoteBackends.set(location.host, backend);
  }
  return backend;
}
