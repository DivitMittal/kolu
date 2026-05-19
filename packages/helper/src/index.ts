#!/usr/bin/env node
/**
 * SSH-side helper for remote Kolu terminals.
 *
 * The helper speaks newline-delimited JSON on stdio. It owns node-pty on the
 * SSH host; the controller owns screen serialization and metadata parsing.
 */

import { createInterface } from "node:readline";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import {
  HELPER_PROTOCOL_VERSION,
  type AgentInfo,
  type AgentKind,
  type HelperAgentState,
  type HelperErrorShape,
  type HelperEvent,
  type HelperFsReadFileResult,
  HelperRequestSchema,
  type HelperSpawnPtyParams,
  type HelperSpawnPtyResult,
  type HelperWatchAgentParams,
  type HelperWatchAgentResult,
} from "kolu-common/helper-protocol";
import { DEFAULT_COLS, DEFAULT_ROWS } from "kolu-common/config";
import { claudeCodeProvider } from "kolu-claude-code";
import { codexProvider } from "kolu-codex";
import {
  getDiff,
  getStatus,
  listAll,
  readFile,
  resolveGitInfo,
  type GitError,
  type GitInfo,
  type GitResult,
} from "kolu-git";
import { opencodeProvider } from "kolu-opencode";
import type {
  AgentInfoShape,
  AgentProvider,
  AgentTerminalState,
  AgentWatcher,
} from "anyagent";
import type { Logger } from "kolu-shared";
import { koluIdentityEnv, prepareShellInit } from "kolu-shared/shell";
import * as pty from "node-pty";
import pkg from "../package.json" with { type: "json" };

interface PtyEntry {
  proc: pty.IPty;
  cleanup: () => void;
  pausedForBackpressure: boolean;
}

type AnyAgentProvider = AgentProvider<unknown, AgentInfoShape>;

interface AgentWatchEntry {
  kind: AgentKind;
  state: HelperAgentState;
  watcher: AgentWatcher | null;
  key: string | null;
}

const ptys = new Map<string, PtyEntry>();
const agentWatches = new Map<string, AgentWatchEntry>();
const agentExternalInstalled = new Set<AgentKind>();
const shellInitDir = join(homedir(), ".kolu-helper", "shell");
const agentProviders = {
  "claude-code": claudeCodeProvider as unknown as AnyAgentProvider,
  codex: codexProvider as unknown as AnyAgentProvider,
  opencode: opencodeProvider as unknown as AnyAgentProvider,
} satisfies Record<AgentKind, AnyAgentProvider>;

function logToStderr(
  level: "debug" | "info" | "warn" | "error",
): (obj: Record<string, unknown>, msg: string) => void {
  return (obj, msg) => {
    process.stderr.write(`${JSON.stringify({ level, msg, ...obj })}\n`);
  };
}

const helperLog: Logger = {
  debug: logToStderr("debug"),
  info: logToStderr("info"),
  warn: logToStderr("warn"),
  error: logToStderr("error"),
};

function status(proc: pty.IPty): {
  process?: string;
  foregroundPid?: number;
} {
  const foregroundPid = (proc as unknown as { foregroundPid?: number })
    .foregroundPid;
  return {
    process: proc.process || undefined,
    foregroundPid:
      foregroundPid && foregroundPid > 0 ? foregroundPid : undefined,
  };
}

function writeFrame(frame: unknown): boolean {
  return process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function writeError(id: number, error: HelperErrorShape): void {
  writeFrame({ id, error });
}

function writeEvent(event: HelperEvent): void {
  writeFrame(event);
}

function gitErrorMessage(error: GitError): string {
  switch (error.code) {
    case "NOT_A_REPO":
      return "Not a git repository";
    case "BASE_BRANCH_NOT_FOUND":
    case "WORKTREE_NAME_COLLISION":
    case "GIT_FAILED":
      return error.message;
    case "PATH_ESCAPES_ROOT":
      return `Path escapes root: ${error.child}`;
  }
  const _exhaustive: never = error;
  return _exhaustive;
}

function unwrapGit<T>(result: GitResult<T>): T {
  if (result.ok) return result.value;
  throw Object.assign(new Error(gitErrorMessage(result.error)), {
    helperKind: result.error.code === "NOT_A_REPO" ? "not-found" : "internal",
  });
}

async function resolveGitInfoOrNull(cwd: string): Promise<GitInfo | null> {
  const result = await resolveGitInfo(cwd, helperLog);
  if (result.ok) return result.value;
  if (result.error.code === "NOT_A_REPO") return null;
  return unwrapGit(result);
}

function agentState(input: HelperAgentState): AgentTerminalState {
  return {
    foregroundPid: input.foregroundPid,
    cwd: input.cwd,
    readForegroundBasename: () => input.foregroundProcess,
    lastAgentCommandName: input.lastAgentCommandName,
  };
}

function emitAgentInfo(watchId: string, info: AgentInfo | null): void {
  writeEvent({ method: "agent", params: { watchId, info } });
}

function ensureAgentExternalChanges(kind: AgentKind, state: HelperAgentState) {
  if (agentExternalInstalled.has(kind)) return;
  const provider = agentProviders[kind];
  if (!provider.externalChanges?.isPresent(agentState(state))) return;
  agentExternalInstalled.add(kind);
  provider.externalChanges.install(
    () => {
      for (const [watchId, watch] of agentWatches) {
        if (watch.kind !== kind) continue;
        try {
          reconcileAgentWatch(watchId);
        } catch (err) {
          helperLog.error(
            { err: err instanceof Error ? err.message : String(err), kind },
            "remote agent external-change reconcile failed",
          );
        }
      }
    },
    (err) =>
      helperLog.error(
        { err: err instanceof Error ? err.message : String(err), kind },
        "remote agent external-change listener failed",
      ),
    helperLog,
  );
}

function reconcileAgentWatch(watchId: string): string | null {
  const watch = agentWatches.get(watchId);
  if (!watch) return null;
  ensureAgentExternalChanges(watch.kind, watch.state);
  const provider = agentProviders[watch.kind];
  const session = provider.resolveSession(agentState(watch.state), helperLog);
  const key = session ? provider.sessionKey(session) : null;
  if (watch.key === key) return key;

  watch.watcher?.destroy();
  watch.watcher = null;
  watch.key = null;

  if (!session || !key) {
    emitAgentInfo(watchId, null);
    return null;
  }

  const watcher = provider.createWatcher(
    session,
    (info) => emitAgentInfo(watchId, info as unknown as AgentInfo),
    helperLog,
  );
  watch.watcher = watcher;
  watch.key = key;
  return key;
}

function watchAgent(input: HelperWatchAgentParams): HelperWatchAgentResult {
  const existing = agentWatches.get(input.watchId);
  if (existing && existing.kind !== input.kind) {
    existing.watcher?.destroy();
    agentWatches.delete(input.watchId);
  }
  const current = agentWatches.get(input.watchId);
  agentWatches.set(input.watchId, {
    kind: input.kind,
    state: input.state,
    watcher: current?.watcher ?? null,
    key: current?.key ?? null,
  });
  return { sessionKey: reconcileAgentWatch(input.watchId) };
}

function unwatchAgent(watchId: string): void {
  const watch = agentWatches.get(watchId);
  if (!watch) return;
  watch.watcher?.destroy();
  agentWatches.delete(watchId);
}

function writePtyData(ptyId: string, proc: pty.IPty, data: string): void {
  const entry = ptys.get(ptyId);
  if (!entry) return;
  const accepted = writeFrame({
    method: "data",
    params: { ptyId, data, ...status(proc) },
  } satisfies HelperEvent);
  if (accepted || entry.pausedForBackpressure) return;

  entry.pausedForBackpressure = true;
  proc.pause();
  process.stdout.once("drain", () => {
    const latest = ptys.get(ptyId);
    if (!latest) return;
    latest.pausedForBackpressure = false;
    latest.proc.resume();
  });
}

function removePty(ptyId: string, kill: boolean): void {
  const entry = ptys.get(ptyId);
  if (!entry) return;
  ptys.delete(ptyId);
  entry.cleanup();
  if (kill) entry.proc.kill();
}

function cleanupAll(): void {
  for (const ptyId of [...ptys.keys()]) removePty(ptyId, true);
  for (const watchId of [...agentWatches.keys()]) unwatchAgent(watchId);
}

function spawnPty(input: HelperSpawnPtyParams): HelperSpawnPtyResult {
  const env = { ...(process.env as Record<string, string>) };
  env.SHELL ??= userInfo().shell || "/bin/sh";
  env.HOME ??= homedir();
  Object.assign(env, koluIdentityEnv(pkg.version));

  const shell = env.SHELL;
  const cwd = input.cwd ?? env.HOME ?? "/";
  const init = prepareShellInit({
    shell,
    home: env.HOME,
    terminalId: input.terminalId,
    shellInitDir,
  });
  Object.assign(env, init.env);

  const proc = pty.spawn(shell, init.args, {
    name: "xterm-256color",
    cols: input.cols || DEFAULT_COLS,
    rows: input.rows || DEFAULT_ROWS,
    cwd,
    env,
  });
  const ptyId = input.terminalId;
  ptys.set(ptyId, {
    proc,
    cleanup: init.cleanup,
    pausedForBackpressure: false,
  });

  proc.onData((data) => {
    writePtyData(ptyId, proc, data);
  });
  proc.onExit(({ exitCode }) => {
    removePty(ptyId, false);
    writeEvent({ method: "exit", params: { ptyId, exitCode } });
  });

  return { ptyId, pid: proc.pid, cwd, ...status(proc) };
}

function requirePty(ptyId: string): PtyEntry {
  const entry = ptys.get(ptyId);
  if (!entry)
    throw Object.assign(new Error(`PTY ${ptyId} not found`), {
      helperKind: "not-found" as const,
    });
  return entry;
}

async function handleRequest(raw: unknown): Promise<void> {
  const req = HelperRequestSchema.parse(raw);
  try {
    switch (req.method) {
      case "spawnPty":
        writeFrame({ id: req.id, result: spawnPty(req.params) });
        return;
      case "write":
        requirePty(req.params.ptyId).proc.write(req.params.data);
        writeFrame({ id: req.id, result: null });
        return;
      case "resize":
        requirePty(req.params.ptyId).proc.resize(
          req.params.cols,
          req.params.rows,
        );
        writeFrame({ id: req.id, result: null });
        return;
      case "dispose":
        requirePty(req.params.ptyId);
        removePty(req.params.ptyId, true);
        writeFrame({ id: req.id, result: null });
        return;
      case "resolveGitInfo":
        writeFrame({
          id: req.id,
          result: await resolveGitInfoOrNull(req.params.cwd),
        });
        return;
      case "gitStatus":
        writeFrame({
          id: req.id,
          result: unwrapGit(
            await getStatus(req.params.repoPath, req.params.mode, helperLog),
          ),
        });
        return;
      case "gitDiff":
        writeFrame({
          id: req.id,
          result: unwrapGit(
            await getDiff(
              req.params.repoPath,
              req.params.filePath,
              req.params.mode,
              helperLog,
              req.params.oldPath,
            ),
          ),
        });
        return;
      case "fsListAll":
        writeFrame({
          id: req.id,
          result: {
            paths: unwrapGit(await listAll(req.params.repoPath, helperLog)),
          },
        });
        return;
      case "fsReadFile": {
        const result: HelperFsReadFileResult = unwrapGit(
          await readFile(req.params.repoPath, req.params.filePath, helperLog),
        );
        writeFrame({ id: req.id, result });
        return;
      }
      case "watchAgent":
        writeFrame({ id: req.id, result: watchAgent(req.params) });
        return;
      case "unwatchAgent":
        unwatchAgent(req.params.watchId);
        writeFrame({ id: req.id, result: null });
        return;
    }
  } catch (err) {
    const helperKind =
      (err as { helperKind?: HelperErrorShape["kind"] }).helperKind ??
      (req.method === "spawnPty" ? "spawn-failed" : "internal");
    writeError(req.id, {
      kind: helperKind,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

function serve(): void {
  writeEvent({
    method: "ready",
    params: { version: pkg.version, protocolVersion: HELPER_PROTOCOL_VERSION },
  });
  const input = createInterface({ input: process.stdin });
  input.on("line", (line) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      writeError(0, {
        kind: "invalid",
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    void handleRequest(parsed).catch((err) => {
      writeError(0, {
        kind: "invalid",
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });
  input.on("close", cleanupAll);
}

if (process.argv.includes("--serve")) {
  process.once("SIGHUP", () => {
    cleanupAll();
    process.exit(128 + 1);
  });
  process.once("SIGINT", () => {
    cleanupAll();
    process.exit(128 + 2);
  });
  process.once("SIGTERM", () => {
    cleanupAll();
    process.exit(128 + 15);
  });
  process.once("exit", cleanupAll);
  serve();
} else {
  console.error("usage: kolu-helper --serve");
  process.exit(2);
}
