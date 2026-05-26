/** Re-export the canonical `HostSessionLike` from kolu-shared so
 *  call sites within this package import from a stable single source.
 *  The interface itself lives in kolu-shared because three packages
 *  (kolu-remote-client, kolu-pty's agentPtyProvider, kolu-server's
 *  host-registry) depend on it — keeping the type in this package
 *  would force a cycle. */
export type { HostSessionLike } from "kolu-shared";
