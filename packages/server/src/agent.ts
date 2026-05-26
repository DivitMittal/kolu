/**
 * `kolu agent --stdio` — runs LocalBackend behind oRPC over
 * stdin/stdout.
 *
 * Plan B's pivot: the agent is the same kolu binary running with a
 * different transport. Zero remote-specific business logic; the
 * agent serves `agentContract` (narrow subset, see
 * `kolu-common/agentContract.ts`) and `RemoteBackend` is the only
 * consumer.
 *
 * **Why narrow contract**: pre-implementation review finding E.
 * Serving the full `appRouter` would expose `terminal.create` and
 * `surface.*` to the agent's caller, creating recursion risk and
 * leaking client-facing primitives into a server-internal protocol.
 *
 * Prototype scope: file exists, demonstrates the wiring shape, but the
 * `@orpc/server/standard-peer` ServerPeer hookup is sketched. R-3 will
 * complete:
 *  1. `createServerPeerHandleRequestFn(agentRouter, options)` from
 *     `@orpc/server/standard-peer`.
 *  2. Wire `process.stdin` / `process.stdout` as a `ServerPeer`
 *     (`@orpc/standard-server-peer`).
 *  3. On stdin EOF, killAll local terminals + exit 0.
 */

import { implement, ORPCError } from "@orpc/server";
import { StandardRPCHandler } from "@orpc/server/standard";
import { createServerPeerHandleRequestFn } from "@orpc/server/standard-peer";
import { ServerPeer } from "@orpc/standard-server-peer";
import { agentContract } from "kolu-common/agentContract";
import type { TerminalChannelMap } from "kolu-common/backend";
import { localBackend } from "./backend/local.ts";
import { makeStdioSend, readStdioMessages } from "./backend/stdio-peer.ts";
import { log } from "./log.ts";
import { getTerminal } from "./terminal-registry.ts";

/** Body of every per-channel handler. The kind literal is the single
 *  binding-site source of typo risk — TS catches a mismatched key. */
async function* relayChannel<K extends keyof TerminalChannelMap>(
  id: string,
  kind: K,
  signal: AbortSignal | undefined,
): AsyncGenerator<TerminalChannelMap[K]> {
  for await (const v of localBackend.terminalChannel(id, kind, signal)) {
    yield v;
  }
}

/**
 * The agent's oRPC router — every method delegates to `localBackend`.
 * The kolu server's `RemoteBackend` calls these via the standard-peer
 * client; the data flow matches `LocalBackend` invocations one-to-one.
 *
 * The body sketches the shape; runtime correctness is R-3.
 */
function buildAgentRouter() {
  const t = implement(agentContract);
  return t.router({
    heartbeat: t.heartbeat.handler(async () => ({ ok: true as const })),

    terminal: {
      spawn: t.terminal.spawn.handler(async ({ input }) => {
        const handle = await localBackend.spawnPty({
          id: input.id,
          cwd: input.cwd,
          initialMetadata: input.initialMetadata,
        });
        return { id: handle.id };
      }),
      kill: t.terminal.kill.handler(async ({ input }) =>
        localBackend.killTerminal(input.id),
      ),
      write: t.terminal.write.handler(async ({ input }) => {
        const entry = getTerminal(input.id);
        if (!entry) {
          throw new ORPCError("NOT_FOUND", {
            message: `terminal ${input.id} not found on agent`,
          });
        }
        entry.handle.write(input.data);
      }),
      resize: t.terminal.resize.handler(async ({ input }) => {
        const entry = getTerminal(input.id);
        if (!entry) {
          throw new ORPCError("NOT_FOUND", {
            message: `terminal ${input.id} not found on agent`,
          });
        }
        entry.handle.resize(input.cols, input.rows);
      }),
      uploadFile: t.terminal.uploadFile.handler(async ({ input }) => ({
        path: await localBackend.uploadFile(
          input.id,
          input.name,
          input.base64Data,
        ),
      })),
      // One handler per TerminalChannelMap key; the body is one line
      // that delegates to `relayChannel`. The kind literal is the only
      // varying piece per row — typos cost a type error.
      channelData: t.terminal.channelData.handler(({ input, signal }) =>
        relayChannel(input.id, "data", signal),
      ),
      channelCwd: t.terminal.channelCwd.handler(({ input, signal }) =>
        relayChannel(input.id, "cwd", signal),
      ),
      channelTitle: t.terminal.channelTitle.handler(({ input, signal }) =>
        relayChannel(input.id, "title", signal),
      ),
      channelGit: t.terminal.channelGit.handler(({ input, signal }) =>
        relayChannel(input.id, "git", signal),
      ),
      channelCommandRun: t.terminal.channelCommandRun.handler(
        ({ input, signal }) => relayChannel(input.id, "commandRun", signal),
      ),
      channelAgent: t.terminal.channelAgent.handler(({ input, signal }) =>
        relayChannel(input.id, "agent", signal),
      ),
      channelPr: t.terminal.channelPr.handler(({ input, signal }) =>
        relayChannel(input.id, "pr", signal),
      ),
      channelForeground: t.terminal.channelForeground.handler(
        ({ input, signal }) => relayChannel(input.id, "foreground", signal),
      ),
      channelConnectionState: t.terminal.channelConnectionState.handler(
        ({ input, signal }) =>
          relayChannel(input.id, "connectionState", signal),
      ),
    },

    fs: {
      listAll: t.fs.listAll.handler(async ({ input }) => ({
        paths: await localBackend.fs.listAll(input.repoPath),
      })),
      readFile: t.fs.readFile.handler(async ({ input }) => {
        const result = await localBackend.fs.readFile(
          input.repoPath,
          input.filePath,
        );
        return { kind: "text" as const, ...result };
      }),
      subscribeRepoChange: t.fs.subscribeRepoChange.handler(async function* ({
        input,
        signal,
      }) {
        for await (const _ of localBackend.fs.subscribeRepoChange(
          input.repoPath,
          signal,
        )) {
          yield;
        }
      }),
      subscribeFileChange: t.fs.subscribeFileChange.handler(async function* ({
        input,
        signal,
      }) {
        for await (const _ of localBackend.fs.subscribeFileChange(
          input.repoPath,
          input.filePath,
          signal,
        )) {
          yield;
        }
      }),
    },

    git: {
      getDiff: t.git.getDiff.handler(async ({ input }) =>
        localBackend.git.getDiff(
          input.repoPath,
          input.filePath,
          input.mode,
          input.oldPath,
        ),
      ),
      getStatus: t.git.getStatus.handler(async ({ input }) =>
        localBackend.git.getStatus(input.repoPath, input.mode),
      ),
    },
  });
}

/**
 * Entry point for `kolu agent --stdio`. The dispatcher in `index.ts`
 * calls this when the `--stdio` flag is set.
 *
 * R-3 wires `@orpc/server/standard-peer` to `process.stdin` /
 * `process.stdout` so the agent reads request envelopes from stdin and
 * writes responses to stdout. The router constructed above is the
 * handler. Sketched for the prototype.
 */
export async function runAgent(): Promise<void> {
  const router = buildAgentRouter();
  // biome-ignore lint/suspicious/noExplicitAny: implement() returns a typed
  // router; StandardRPCHandler accepts the broader oRPC `Router` shape.
  // Runtime structure is compatible — same cast pattern as `index.ts`.
  const handler = new StandardRPCHandler(router as any, {});
  const peerHandle = createServerPeerHandleRequestFn(handler, {
    context: {},
  });
  const peer = new ServerPeer(makeStdioSend(process.stdout));
  log.info("kolu agent --stdio: serving on stdin/stdout");

  const stop = readStdioMessages(
    process.stdin,
    async (msg) => {
      try {
        await peer.message(msg, peerHandle);
      } catch (err) {
        log.error({ err }, "kolu agent: message handler error");
      }
    },
    () => {
      log.info("kolu agent: stdin closed, shutting down");
      peer.close();
      // Clean up any spawned terminals before exiting.
      void import("./terminals.ts").then(({ killAllTerminals }) => {
        killAllTerminals();
        process.exit(0);
      });
    },
  );

  // Resume stdin to start data flowing. node defaults paused for raw streams.
  process.stdin.resume();

  // Keep the event loop alive until stdin closes.
  await new Promise<void>((resolve) => {
    process.stdin.once("close", () => {
      stop();
      resolve();
    });
  });
}
