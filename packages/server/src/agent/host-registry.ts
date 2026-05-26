/**
 * Per-host `HostSession` registry. Phase 2a of kolu#951.
 *
 * One singleton `HostSession` per host alias — every remote terminal,
 * git watcher, and code-tab subscription targeted at the same host
 * shares the same ssh subprocess. Lazy: the session is constructed
 * (and the agent installed via `AgentBootstrap`) on first request,
 * then cached.
 *
 * Phase 2a deliberately does NOT release a session when the last
 * terminal for a host closes — keeping the ssh connection warm
 * amortises the connect cost for the next "New terminal on srid-box"
 * click. A future cleanup pass can add an idle TTL.
 */

import type { Logger } from "kolu-shared";
import { ensureAgent } from "./bootstrap.ts";
import { HostSession } from "./host-session.ts";

interface CachedSession {
  session: HostSession;
  /** Promise resolved when the initial connect (incl. agent install)
   *  succeeds. Multiple concurrent callers await the same promise. */
  ready: Promise<void>;
}

const sessions = new Map<string, CachedSession>();

/** Get (or lazily build) the HostSession for `host`. The returned
 *  session is `connected` once the awaited promise resolves; the
 *  caller's RPC calls / subscriptions wait on `ready` before flushing. */
export function getHostSession(host: string, log: Logger): CachedSession {
  const existing = sessions.get(host);
  if (existing) return existing;

  // Build placeholder first so the closure inside `ready` can mutate
  // `cached.session` once the real session is connected. Before
  // `ready` resolves, `cached.session` is a placeholder that throws —
  // any caller that tries to RPC before awaiting `ready` gets a clear
  // error.
  const cached: CachedSession = {
    session: makePlaceholderSession(host),
    ready: Promise.resolve(),
  };
  cached.ready = (async () => {
    const { remoteAgentPath } = await ensureAgent(host, log);
    const session = new HostSession({ host, remoteAgentPath, log });
    await session.connect();
    cached.session = session;
  })();
  sessions.set(host, cached);
  return cached;
}

/** Tear down the session for `host` (if any) — used by the disconnect
 *  modal's Reconnect action. */
export async function closeHostSession(host: string): Promise<void> {
  const cached = sessions.get(host);
  if (!cached) return;
  sessions.delete(host);
  try {
    await cached.session.close();
  } catch {
    // best-effort
  }
}

function makePlaceholderSession(host: string): HostSession {
  const err = () => {
    throw new Error(
      `HostSession for ${host} not ready yet — await cached.ready first`,
    );
  };
  // Cast through unknown — the placeholder satisfies HostSession's
  // shape only structurally and only as a not-yet-ready guard.
  return {
    connect: err,
    call: err,
    subscribe: err,
    onStateChange: err,
    currentState: () => ({ kind: "connecting" as const }),
    close: async () => {},
  } as unknown as HostSession;
}
