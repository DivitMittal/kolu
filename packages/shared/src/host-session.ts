/** Narrow consumer interface for a per-host RPC channel. Defined
 *  here in kolu-shared so any package that needs to consume a
 *  session (kolu-remote-client, kolu-pty's agentPtyProvider,
 *  kolu-server's meta/* orchestrators) can import the type without
 *  closing a cycle into kolu-server's concrete `HostSession` class.
 *
 *  The narrowing is deliberate: callers see `call` + `subscribe` and
 *  nothing else. The state machine, heartbeat, reconnect, and
 *  subscription re-issue all live behind the interface in
 *  `kolu-server/src/agent/host-session.ts`. */
export interface HostSessionLike {
  /** Request/response RPC. Awaits the remote agent's reply. */
  call(method: string, args: unknown): Promise<unknown>;
  /** Streaming subscription. The returned token's `update` is
   *  fire-and-forget on the wire (mutate the subscription's args);
   *  `close` tears it down. The session re-issues the underlying
   *  subscription transparently across reconnects — the callback
   *  keeps firing without callers seeing the churn. */
  subscribe<UpdateParams = unknown>(
    method: string,
    args: unknown,
    onEvent: (payload: unknown) => void,
  ): {
    update(params: UpdateParams): Promise<void>;
    close(): Promise<void>;
  };
}
