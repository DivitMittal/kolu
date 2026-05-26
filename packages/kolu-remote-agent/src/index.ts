/**
 * kolu-remote-agent — the binary deployed on a remote host that
 * kolu-server talks to over ssh stdio. Phase 2a of kolu#951.
 *
 * Architecture: one Node process per host, running the same kolu
 * integration packages (`kolu-git`, `kolu-github`, `kolu-pty`) the
 * local server uses — just with stdin/stdout as the transport. The
 * client side (`packages/server/src/agent/host-session.ts`) opens an
 * ssh subprocess that runs this binary and pipes JSON-RPC frames.
 *
 * Symmetry with Zed's `headless_project`
 * (`/tmp/zed/crates/remote_server/src/headless_project.rs:51`): the
 * agent and server share the same in-repo integrations; only the
 * transport differs. Adding a new domain to the protocol is one
 * handler registration here + one client class in `kolu-remote-client`.
 *
 * **Prototype scope.** This file establishes the handler-registration
 * shape and the `git.subscribeInfo` handler as a worked example.
 * `agent.subscribe`, `github.subscribePr`, `fs.listAll`, and
 * `terminal.spawn`/`terminal.attach` (Phase 3) ship the same way —
 * one handler each. Auto-install / version negotiation happens on the
 * server side (`AgentBootstrap`), not here.
 */

import { localGitInfoProvider, type GitInfoSubscription } from "kolu-git";
import type { Logger } from "kolu-shared";
import { createInterface } from "node:readline";
import {
  GitSubscribeInfoInputSchema,
  type RpcEvent,
  RpcRequestSchema,
  type RpcResponse,
  SubscriptionCloseInputSchema,
  SubscriptionUpdateInputSchema,
  VersionResultSchema,
} from "./protocol.ts";

const AGENT_VERSION = "0.1.0";

/** Active server-side subscriptions, keyed by the integer handle the
 *  client tracks. Closing the wire (ssh dropped) drains the map and
 *  releases each subscription's underlying watcher. */
interface AgentSubscription {
  kind: "git.info";
  handle: GitInfoSubscription;
}

/** Minimal logger matching kolu-shared's `Logger` shape. Writes to
 *  stderr so it doesn't pollute the stdout JSON-RPC frame stream. */
const agentLog: Logger = {
  debug: (obj, msg) => console.error("[debug]", msg, obj),
  info: (obj, msg) => console.error("[info]", msg, obj),
  warn: (obj, msg) => console.error("[warn]", msg, obj),
  error: (obj, msg) => console.error("[error]", msg, obj),
};

/** Write one frame to stdout — newline-delimited JSON. The client's
 *  readline interface picks it up. */
function writeFrame(frame: object): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

/** Build a response envelope for the given request id. The wire union
 *  in `protocol.ts` discriminates by `kind`. */
function ok(id: number, result: unknown): void {
  const resp: RpcResponse = { id, result };
  writeFrame({ kind: "response", ...resp });
}

function fail(id: number, code: string, message: string): void {
  const resp: RpcResponse = { id, error: { code, message } };
  writeFrame({ kind: "response", ...resp });
}

/** Stream one event payload to the subscription's owner. */
function emitEvent(subscription: number, payload: unknown): void {
  const evt: RpcEvent = { subscription, payload };
  writeFrame({ kind: "event", ...evt });
}

export function runAgent(): void {
  const subscriptions = new Map<number, AgentSubscription>();
  let nextSubscriptionId = 1;

  const rl = createInterface({ input: process.stdin });
  agentLog.info({ version: AGENT_VERSION }, "kolu-remote-agent started");

  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      agentLog.error({ err: String(err), line }, "invalid json frame");
      return;
    }

    const req = RpcRequestSchema.safeParse(parsed);
    if (!req.success) {
      agentLog.error({ issues: req.error.issues, line }, "invalid rpc request");
      return;
    }
    const { id, method, params } = req.data;

    try {
      handle(id, method, params, subscriptions, () => nextSubscriptionId++);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      fail(id, "HANDLER_ERROR", msg);
    }
  });

  rl.on("close", () => {
    agentLog.info(
      { count: subscriptions.size },
      "stdin closed — releasing all subscriptions",
    );
    for (const sub of subscriptions.values()) {
      try {
        sub.handle.stop();
      } catch {
        // ignore; we're shutting down anyway
      }
    }
    subscriptions.clear();
    process.exit(0);
  });
}

function handle(
  id: number,
  method: string,
  params: unknown,
  subscriptions: Map<number, AgentSubscription>,
  allocSubscription: () => number,
): void {
  switch (method) {
    case "ping": {
      ok(id, { pong: Date.now() });
      return;
    }
    case "version": {
      const result = VersionResultSchema.parse({
        agentVersion: AGENT_VERSION,
        platform: `${process.platform}-${process.arch}`,
      });
      ok(id, result);
      return;
    }
    case "git.subscribeInfo": {
      const input = GitSubscribeInfoInputSchema.parse(params);
      const subscriptionId = allocSubscription();
      // Reuse the LOCAL git provider — on the agent, "local" means the
      // remote machine's filesystem. That's the symmetry Zed exploits
      // and the whole point of this layer.
      const handle = localGitInfoProvider.subscribe(
        input.cwd,
        (info) => emitEvent(subscriptionId, info),
        agentLog,
      );
      subscriptions.set(subscriptionId, { kind: "git.info", handle });
      ok(id, { subscription: subscriptionId });
      return;
    }
    case "subscription.update": {
      const input = SubscriptionUpdateInputSchema.parse(params);
      const sub = subscriptions.get(input.subscription);
      if (!sub) {
        fail(id, "NOT_FOUND", `unknown subscription ${input.subscription}`);
        return;
      }
      // Phase 2a prototype: only git.info supports update (setCwd).
      // Other subscription kinds add their update arg here.
      if (sub.kind === "git.info") {
        const params = input.params as { cwd?: string };
        if (typeof params.cwd === "string") sub.handle.setCwd(params.cwd);
      }
      ok(id, null);
      return;
    }
    case "subscription.close": {
      const input = SubscriptionCloseInputSchema.parse(params);
      const sub = subscriptions.get(input.subscription);
      if (sub) {
        sub.handle.stop();
        subscriptions.delete(input.subscription);
      }
      ok(id, null);
      return;
    }
    // TODO Phase 2b: agent.subscribe, github.subscribePr, fs.listAll,
    // fs.readFile, fs.statFileMtimeMs each get a handler here.
    // TODO Phase 3: terminal.spawn, terminal.attach for PTY-over-agent.
    default:
      fail(id, "METHOD_NOT_FOUND", `unknown method: ${method}`);
  }
}

// When invoked directly (kolu-server runs `node .../dist/index.js` on
// the remote), boot the agent. When imported by tests, runAgent is a
// no-op until the test calls it.
if (
  process.argv[1] &&
  /kolu-remote-agent[/\\](dist|src)[/\\]index\.[jt]s$/.test(process.argv[1])
) {
  runAgent();
}
