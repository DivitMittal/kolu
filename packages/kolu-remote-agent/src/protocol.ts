/**
 * Wire protocol — JSON-RPC over stdio between kolu-server and the
 * remote `kolu-remote-agent` binary running on the host. Phase 2a of
 * kolu#951.
 *
 * Framed line-by-line: each message is one JSON object on a single line
 * (newline-delimited). Three kinds:
 *
 *   - **Request** — `{ id, method, params }`. Awaits a `Response`.
 *   - **Response** — `{ id, result | error }`. Correlates by id.
 *   - **Event** — `{ subscription, payload }`. Streamed by the agent
 *     after a `subscribe` request returned the subscription handle.
 *
 * Length-prefix framing (à la Zed's protobuf Envelope) would be more
 * efficient, but newline-delimited JSON is the simpler choice for a
 * prototype — every line is independently parseable, easy to debug
 * with `tee | jq`. Phase 3 can switch to length-prefixing if PTY-byte
 * throughput needs it.
 *
 * Method names are namespaced by domain: `git.subscribeInfo`,
 * `agent.subscribe`, `terminal.spawn`, etc. The agent's RPC handler
 * map (`src/index.ts`) routes each namespace to its provider.
 */

import { z } from "zod";

// ── Request / response envelopes ──────────────────────────────────────

export const RpcRequestSchema = z.object({
  /** Monotonic request id assigned by the client; the agent echoes it
   *  back in the response so the client correlates. */
  id: z.number().int().nonnegative(),
  /** Domain-namespaced method, e.g. `git.subscribeInfo`. */
  method: z.string(),
  /** Method-specific parameters. The agent's handler validates with the
   *  domain schema. */
  params: z.unknown(),
});
export type RpcRequest = z.infer<typeof RpcRequestSchema>;

export const RpcResponseSchema = z.object({
  id: z.number().int().nonnegative(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
    })
    .optional(),
});
export type RpcResponse = z.infer<typeof RpcResponseSchema>;

/** Streamed event from the agent — fired after a `subscribe`-shaped
 *  method has returned a subscription handle. The agent uses the
 *  handle's integer id; the client routes by it. */
export const RpcEventSchema = z.object({
  subscription: z.number().int().nonnegative(),
  payload: z.unknown(),
});
export type RpcEvent = z.infer<typeof RpcEventSchema>;

/** Tagged union: every line on the wire is one of these three shapes.
 *  The client parses each newline-delimited chunk into this union and
 *  dispatches. */
export const RpcFrameSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("request"), ...RpcRequestSchema.shape }),
  z.object({ kind: z.literal("response"), ...RpcResponseSchema.shape }),
  z.object({ kind: z.literal("event"), ...RpcEventSchema.shape }),
]);
export type RpcFrame = z.infer<typeof RpcFrameSchema>;

// ── Method schemas (subset for prototype) ─────────────────────────────

/** `ping` — heartbeat. Agent echoes a monotonic counter so the client
 *  can detect stalls. */
export const PingResultSchema = z.object({ pong: z.number() });
export type PingResult = z.infer<typeof PingResultSchema>;

/** `version` — bootstrap probe; the client checks this matches its
 *  expected agent version before any other method runs. */
export const VersionResultSchema = z.object({
  agentVersion: z.string(),
  /** Platform string ('darwin-arm64', 'linux-x64') the agent reports
   *  about itself — informational only. */
  platform: z.string(),
});

/** `git.subscribeInfo` — start a per-cwd git-info subscription on the
 *  remote. Returns `{ subscription }`; events arrive as
 *  `RpcEvent { subscription, payload: GitInfo | null }`. */
export const GitSubscribeInfoInputSchema = z.object({
  cwd: z.string(),
});

/** `subscription.update` — call with a new arg payload to mutate an
 *  existing subscription (e.g. `setCwd` for git info). */
export const SubscriptionUpdateInputSchema = z.object({
  subscription: z.number().int().nonnegative(),
  params: z.unknown(),
});

/** `subscription.close` — tear down a subscription. */
export const SubscriptionCloseInputSchema = z.object({
  subscription: z.number().int().nonnegative(),
});

/** `terminal.spawn` — Phase 3 of kolu#951. Spawn a PTY on the remote;
 *  bytes stream back as events. Returns a remote session id usable for
 *  reattach across reconnects. */
export const TerminalSpawnInputSchema = z.object({
  cwd: z.string().optional(),
  cols: z.number().int().positive().default(80),
  rows: z.number().int().positive().default(24),
});
export const TerminalSpawnResultSchema = z.object({
  remoteSessionId: z.string().uuid(),
  subscription: z.number().int().nonnegative(),
});

/** `terminal.attach` — Phase 3 reattach. Resume an existing remote
 *  session by id; agent replays a scrollback snapshot then resumes
 *  streaming. Idempotent: re-attaching is a no-op if the session is
 *  already streaming. */
export const TerminalAttachInputSchema = z.object({
  remoteSessionId: z.string().uuid(),
});
