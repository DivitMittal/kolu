/**
 * Search-index worker manager — owns the child-process lifecycle and
 * the typed Surface client for talking to it.
 *
 * Spawns `src/worker/index.ts` via `tsx` (dev path) or
 * `tsx src/worker/index.ts` (prod path; tsx is in the example's
 * devDependencies). Pipes the child's stdin/stdout into a
 * Surface-stdio client. Forwards the child's stderr to the parent's
 * stderr so worker logs are visible alongside server logs.
 *
 * Lifecycle: lazy spawn on first `getWorker()` call. The worker stays
 * alive for the parent's lifetime. On parent SIGTERM/SIGINT, kill the
 * child and clean up.
 *
 * The returned client is the standard typed oRPC client — call
 * `client.surface.search.get(...)` for the search stream and
 * `client.surface.index.update(...)` for the imperative procedure.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import type { ContractRouterClient } from "@orpc/contract";
import { createStdioCellsClient } from "@kolu/surface/links/stdio";
import { workerSurface } from "../worker/surface";

type WorkerClient = ContractRouterClient<typeof workerSurface.contract>;

interface RunningWorker {
  child: ChildProcess;
  client: WorkerClient;
}

let running: RunningWorker | null = null;

const HERE = fileURLToPath(new URL(".", import.meta.url));
const WORKER_ENTRY = resolvePath(HERE, "..", "worker", "index.ts");

function spawnWorker(): RunningWorker {
  // `tsx` is in devDependencies for dev; in the Nix-built dist path the
  // worker would be a compiled JS entry. Keep dev simple — tsx handles
  // both .ts and .js seamlessly.
  const child = spawn("tsx", [WORKER_ENTRY], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.on("error", (err) => {
    process.stderr.write(`[server] worker spawn error: ${String(err)}\n`);
  });
  child.on("exit", (code, signal) => {
    process.stderr.write(
      `[server] worker exited code=${code} signal=${signal ?? "none"}\n`,
    );
    running = null;
  });
  // Surface worker stderr inline. Each line is prefixed by the worker
  // itself with its pid.
  child.stderr?.on("data", (chunk: Buffer) => {
    process.stderr.write(chunk);
  });

  if (!child.stdin || !child.stdout) {
    throw new Error("[server] worker spawned without piped stdio");
  }

  const client = createStdioCellsClient<typeof workerSurface.contract>({
    write: child.stdin,
    read: child.stdout,
  });
  return { child, client };
}

export function getWorker(): WorkerClient {
  if (!running) {
    running = spawnWorker();
    process.stderr.write(
      `[server] spawned search-index worker pid=${running.child.pid ?? "?"}\n`,
    );
  }
  return running.client;
}

/** Tear down the worker (used on parent shutdown). */
export function stopWorker(): void {
  if (!running) return;
  running.child.kill("SIGTERM");
  running = null;
}

// Clean up worker on parent exit signals. Without this, the worker
// becomes an orphan when the parent is killed.
process.once("SIGTERM", stopWorker);
process.once("SIGINT", stopWorker);
process.once("exit", stopWorker);
