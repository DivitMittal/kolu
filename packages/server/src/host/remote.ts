import {
  type ChildProcessWithoutNullStreams,
  execFileSync,
  spawn,
} from "node:child_process";
import { createInterface } from "node:readline";
import {
  HELPER_PROTOCOL_VERSION,
  type AgentInfo,
  type AgentKind,
  type HelperAgentEvent,
  type HelperDataEvent,
  HelperEventSchema,
  type HelperExitEvent,
  type HelperFsReadFileResult,
  type HelperParams,
  type HelperRpcMethod,
  type HelperResult,
  HelperResponseSchema,
  parseHelperResult,
} from "kolu-common/helper-protocol";
import { DEFAULT_COLS, DEFAULT_ROWS } from "kolu-common/config";
import type { HostSummary } from "kolu-common/contract";
import {
  err as gitErr,
  gitInfoEqual,
  ok as gitOk,
  type GitDiffOutput,
  type GitError,
  type GitInfo,
  type GitResult,
  type GitStatusOutput,
} from "kolu-git";
import { match } from "ts-pattern";
import { log, type Logger } from "../log.ts";
import { createPtyScreen, type PtyHandle, type PtyScreen } from "../pty.ts";
import type { Host, HostAgentState, HostAgentWatch } from "./types.ts";

const HELPER_READY_TIMEOUT_MS = 120_000;
const HELPER_REQUEST_TIMEOUT_MS = 60_000;
const MAX_HELPER_STDERR_CHARS = 12_000;
const DEFAULT_HELPER_FLAKE = "github:juspay/kolu";

interface PendingRequest {
  resolve(result: unknown): void;
  reject(err: Error): void;
}

type PendingPtyEvent = HelperDataEvent | HelperExitEvent;

interface PendingPty {
  events: PendingPtyEvent[];
  overflowed: boolean;
}

interface PtyEventHandlers {
  onData(event: HelperDataEvent): void;
  onExit(event: HelperExitEvent): void;
}

interface AgentEventHandlers {
  onChange(info: AgentInfo | null): void;
}

interface RemoteHostOpts {
  summary: HostSummary;
  helperRemoteCmd?: string;
}

const MAX_PENDING_PTY_EVENTS = 512;
const REMOTE_GIT_POLL_MS = 2_000;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function currentGitRev(): string | null {
  try {
    const rev = execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return /^[0-9a-f]{40}$/i.test(rev) ? rev : null;
  } catch {
    return null;
  }
}

function defaultHelperRemoteCmd(): string {
  const commitHash =
    process.env.KOLU_COMMIT_HASH?.match(/^[0-9a-f]{7,40}$/i)?.[0] ??
    currentGitRev();
  const flakeRef = commitHash
    ? `${DEFAULT_HELPER_FLAKE}/${commitHash}`
    : DEFAULT_HELPER_FLAKE;
  const command = `nix --extra-experimental-features "nix-command flakes" run --refresh ${shellQuote(flakeRef)}#kolu-helper -- --serve`;
  return `bash -lc ${shellQuote(command)}`;
}

function appendTail(current: string, chunk: string): string {
  const next = current + chunk;
  return next.length > MAX_HELPER_STDERR_CHARS
    ? next.slice(next.length - MAX_HELPER_STDERR_CHARS)
    : next;
}

function gitErrorFromHelper(err: unknown): GitError {
  const message = err instanceof Error ? err.message : String(err);
  if (/helper not-found:/i.test(message)) return { code: "NOT_A_REPO" };
  return { code: "GIT_FAILED", message };
}

function remoteChangePoll(onChange: () => void): () => void {
  const timer = setInterval(onChange, REMOTE_GIT_POLL_MS);
  return () => clearInterval(timer);
}

export function createRemoteHost(opts: RemoteHostOpts): Host {
  const { summary } = opts;
  const helperRemoteCmd = opts.helperRemoteCmd ?? defaultHelperRemoteCmd();
  const fallbackLog = log.child({ host: summary.id });
  let child: ChildProcessWithoutNullStreams | null = null;
  let connectPromise: Promise<void> | null = null;
  let helperReady = false;
  let readyResolve: (() => void) | null = null;
  let readyReject: ((err: Error) => void) | null = null;
  let nextRequestId = 1;
  const pending = new Map<number, PendingRequest>();
  const pendingPtys = new Map<string, PendingPty>();
  const ptys = new Map<string, PtyEventHandlers>();
  const agentWatchers = new Map<string, AgentEventHandlers>();

  function rejectAll(err: Error): void {
    for (const req of pending.values()) req.reject(err);
    pending.clear();
    readyReject?.(err);
    readyReject = null;
    readyResolve = null;
    helperReady = false;
  }

  function queuePendingPtyEvent(event: PendingPtyEvent, tlog: Logger): void {
    const ptyId = event.params.ptyId;
    const pendingPty = pendingPtys.get(ptyId);
    if (!pendingPty) {
      tlog.warn({ host: summary.id, ptyId }, "helper event for unknown pty");
      return;
    }
    if (pendingPty.events.length >= MAX_PENDING_PTY_EVENTS) {
      pendingPty.overflowed = true;
      return;
    }
    pendingPty.events.push(event);
  }

  function dispatchFrame(line: string, tlog: Logger): void {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch (err) {
      tlog.error({ err, host: summary.id, line }, "helper sent invalid JSON");
      return;
    }

    const response = HelperResponseSchema.safeParse(parsed);
    if (
      response.success &&
      (response.data.result !== undefined || response.data.error)
    ) {
      const req = pending.get(response.data.id);
      if (!req) {
        tlog.error(
          { host: summary.id, id: response.data.id },
          "helper response for unknown request",
        );
        return;
      }
      pending.delete(response.data.id);
      if (response.data.error) {
        req.reject(
          new Error(
            `helper ${response.data.error.kind}: ${response.data.error.message}`,
          ),
        );
      } else {
        req.resolve(response.data.result);
      }
      return;
    }

    const event = HelperEventSchema.safeParse(parsed);
    if (!event.success) {
      tlog.error({ host: summary.id, line }, "helper sent unknown frame");
      return;
    }

    match(event.data)
      .with({ method: "ready" }, (ready) => {
        if (ready.params.protocolVersion !== HELPER_PROTOCOL_VERSION) {
          const err = new Error(
            `remote helper protocol ${ready.params.protocolVersion} does not match server protocol ${HELPER_PROTOCOL_VERSION}`,
          );
          tlog.error(
            {
              host: summary.id,
              helperVersion: ready.params.version,
              protocolVersion: ready.params.protocolVersion,
              expectedProtocolVersion: HELPER_PROTOCOL_VERSION,
            },
            "remote helper protocol mismatch",
          );
          readyReject?.(err);
          child?.kill();
          return;
        }
        tlog.info(
          {
            host: summary.id,
            version: ready.params.version,
            protocolVersion: ready.params.protocolVersion,
          },
          "remote helper ready",
        );
        helperReady = true;
        readyResolve?.();
        readyResolve = null;
        readyReject = null;
      })
      .with({ method: "data" }, (data) => {
        const reg = ptys.get(data.params.ptyId);
        if (reg) reg.onData(data);
        else queuePendingPtyEvent(data, tlog);
      })
      .with({ method: "exit" }, (exit) => {
        const reg = ptys.get(exit.params.ptyId);
        if (reg) reg.onExit(exit);
        else queuePendingPtyEvent(exit, tlog);
      })
      .with({ method: "agent" }, (agent: HelperAgentEvent) => {
        const reg = agentWatchers.get(agent.params.watchId);
        if (reg) reg.onChange(agent.params.info);
        else
          tlog.warn(
            { host: summary.id, watchId: agent.params.watchId },
            "helper agent event for unknown watch",
          );
      })
      .exhaustive();
  }

  function ensureConnected(tlog: Logger): Promise<void> {
    if (helperReady && child) return Promise.resolve();
    if (connectPromise !== null) return connectPromise;

    connectPromise = new Promise<void>((resolve, reject) => {
      const ssh = spawn("ssh", ["-T", summary.id, helperRemoteCmd], {
        stdio: "pipe",
      });
      let stderrTail = "";
      child = ssh;
      helperReady = false;

      const helperFailure = (reason: string): Error => {
        const stderr = stderrTail.trim();
        const details = stderr
          ? `\n\nRemote stderr:\n${stderr}`
          : "\n\nRemote stderr was empty.";
        return new Error(`ssh helper for ${summary.id} ${reason}.${details}`);
      };

      const readyTimer = setTimeout(() => {
        readyReject?.(helperFailure("did not become ready"));
        ssh.kill();
      }, HELPER_READY_TIMEOUT_MS);
      readyResolve = () => {
        clearTimeout(readyTimer);
        resolve();
      };
      readyReject = (err) => {
        clearTimeout(readyTimer);
        reject(err);
      };

      createInterface({ input: ssh.stdout }).on("line", (line) =>
        child === ssh ? dispatchFrame(line, tlog) : undefined,
      );
      ssh.stderr.on("data", (data: Buffer) => {
        if (child !== ssh) return;
        const text = data.toString();
        stderrTail = appendTail(stderrTail, text);
        tlog.debug({ host: summary.id, stderr: text }, "ssh stderr");
      });
      ssh.on("error", (err) => {
        if (child !== ssh) return;
        child = null;
        connectPromise = null;
        rejectAll(err);
      });
      ssh.on("exit", (code, signal) => {
        if (child !== ssh) return;
        clearTimeout(readyTimer);
        child = null;
        connectPromise = null;
        helperReady = false;
        const reason =
          signal !== null
            ? `exited from signal ${signal}`
            : `exited with code ${code ?? "unknown"}`;
        const err = helperFailure(reason);
        tlog.error(
          { err, host: summary.id, stderr: stderrTail, helperRemoteCmd },
          "ssh helper exited before or during remote terminal session",
        );
        rejectAll(err);
        for (const [ptyId, reg] of [...ptys]) {
          ptys.delete(ptyId);
          reg.onExit({
            method: "exit",
            params: { ptyId, exitCode: typeof code === "number" ? code : 255 },
          });
        }
        for (const reg of agentWatchers.values()) reg.onChange(null);
        agentWatchers.clear();
        pendingPtys.clear();
      });
    }).finally(() => {
      if (helperReady || !child) connectPromise = null;
    });

    return connectPromise;
  }

  async function sendRequest<M extends HelperRpcMethod>(
    method: M,
    params: HelperParams<M>,
    tlog: Logger,
  ): Promise<HelperResult<M>> {
    await ensureConnected(tlog);
    if (!child) throw new Error(`remote host ${summary.id}: not connected`);
    const id = nextRequestId++;
    const promise = new Promise<HelperResult<M>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`helper ${method} request timed out`));
      }, HELPER_REQUEST_TIMEOUT_MS);
      pending.set(id, {
        resolve: (result) => {
          clearTimeout(timeout);
          try {
            resolve(parseHelperResult(method, result));
          } catch {
            reject(new Error(`invalid helper response for ${method}`));
          }
        },
        reject: (err) => {
          clearTimeout(timeout);
          reject(err);
        },
      });
    });
    try {
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    } catch (err) {
      const req = pending.get(id);
      pending.delete(id);
      req?.reject(err instanceof Error ? err : new Error(String(err)));
    }
    return promise;
  }

  async function resolveRemoteGitInfo(
    cwd: string,
    tlog: Logger,
  ): Promise<GitResult<GitInfo>> {
    try {
      const info = await sendRequest("resolveGitInfo", { cwd }, tlog);
      return info ? gitOk(info) : gitErr({ code: "NOT_A_REPO" });
    } catch (err) {
      return gitErr(gitErrorFromHelper(err));
    }
  }

  function subscribeRemoteGitInfo(
    initialCwd: string,
    onChange: (info: GitInfo | null) => void,
    tlog?: Logger,
  ) {
    const plog = tlog ?? fallbackLog;
    let currentCwd = initialCwd;
    let currentInfo: GitInfo | null = null;
    let stopped = false;
    let inFlight = false;
    let pendingResolve = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    function schedule(): void {
      if (stopped) return;
      timer = setTimeout(requestResolve, REMOTE_GIT_POLL_MS);
    }

    function requestResolve(): void {
      if (stopped) return;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (inFlight) {
        pendingResolve = true;
        return;
      }
      inFlight = true;
      const cwdAtStart = currentCwd;
      void resolveRemoteGitInfo(cwdAtStart, plog)
        .then((result) => {
          if (stopped || cwdAtStart !== currentCwd) return;
          const next = result.ok ? result.value : null;
          if (!result.ok && result.error.code !== "NOT_A_REPO") {
            plog.error(
              { host: summary.id, code: result.error.code, cwd: currentCwd },
              "remote git resolution failed",
            );
          }
          if (gitInfoEqual(next, currentInfo)) return;
          currentInfo = next;
          onChange(next);
        })
        .catch((err) =>
          plog.error(
            { err, host: summary.id, cwd: currentCwd },
            "remote git resolution threw",
          ),
        )
        .finally(() => {
          inFlight = false;
          if (pendingResolve) {
            pendingResolve = false;
            requestResolve();
          } else {
            schedule();
          }
        });
    }

    requestResolve();
    return {
      setCwd(next: string): void {
        if (stopped || next === currentCwd) return;
        currentCwd = next;
        requestResolve();
      },
      stop(): void {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    };
  }

  async function remoteGit<T>(action: () => Promise<T>): Promise<GitResult<T>> {
    try {
      return gitOk(await action());
    } catch (err) {
      return gitErr(gitErrorFromHelper(err));
    }
  }

  function startAgentWatch(
    kind: AgentKind,
    state: HostAgentState,
    onChange: (info: AgentInfo | null) => void,
    tlog?: Logger,
  ): HostAgentWatch {
    const plog = tlog ?? fallbackLog;
    const watchId = crypto.randomUUID();
    let stopped = false;
    let active = false;
    let queued: HostAgentState | null = state;
    agentWatchers.set(watchId, { onChange });

    async function drain(): Promise<void> {
      if (active) return;
      active = true;
      try {
        while (!stopped && queued) {
          const next = queued;
          queued = null;
          const result = await sendRequest(
            "watchAgent",
            { watchId, kind, state: next },
            plog,
          );
          if (!stopped && result.sessionKey === null) onChange(null);
        }
      } catch (err) {
        plog.error(
          { err, host: summary.id, kind, watchId },
          "remote agent watch failed",
        );
        if (!stopped) onChange(null);
      } finally {
        active = false;
        if (!stopped && queued) void drain();
      }
    }

    void drain();
    return {
      update(next: HostAgentState): void {
        if (stopped) return;
        queued = next;
        void drain();
      },
      stop(): void {
        if (stopped) return;
        stopped = true;
        queued = null;
        agentWatchers.delete(watchId);
        void sendRequest("unwatchAgent", { watchId }, plog).catch((err) =>
          plog.error(
            { err, host: summary.id, kind, watchId },
            "remote agent unwatch failed",
          ),
        );
      },
    };
  }

  function maybeShutdown(): void {
    if (ptys.size > 0) return;
    child?.kill();
    child = null;
  }

  return {
    summary,
    subscribeGitInfo: subscribeRemoteGitInfo,
    getStatus(repoPath, mode, tlog) {
      return remoteGit<GitStatusOutput>(() =>
        sendRequest("gitStatus", { repoPath, mode }, tlog ?? fallbackLog),
      );
    },
    getDiff(repoPath, filePath, mode, tlog, oldPath) {
      return remoteGit<GitDiffOutput>(() =>
        sendRequest(
          "gitDiff",
          { repoPath, filePath, mode, oldPath },
          tlog ?? fallbackLog,
        ),
      );
    },
    listAll(repoPath, tlog) {
      return remoteGit<string[]>(async () => {
        const result = await sendRequest(
          "fsListAll",
          { repoPath },
          tlog ?? fallbackLog,
        );
        return result.paths;
      });
    },
    readFile(repoPath, filePath, tlog) {
      return remoteGit<HelperFsReadFileResult>(() =>
        sendRequest("fsReadFile", { repoPath, filePath }, tlog ?? fallbackLog),
      );
    },
    subscribeRepoChange(_repoRoot, onChange) {
      return remoteChangePoll(onChange);
    },
    subscribeFileChange(_repoRoot, _filePath, onChange) {
      return remoteChangePoll(onChange);
    },
    watchAgent: startAgentWatch,
    async spawnPty(tlog, terminalId, opts, cwd): Promise<PtyHandle> {
      pendingPtys.set(terminalId, { events: [], overflowed: false });
      let result: HelperResult<"spawnPty">;
      try {
        result = await sendRequest(
          "spawnPty",
          {
            terminalId,
            cwd,
            cols: DEFAULT_COLS,
            rows: DEFAULT_ROWS,
          },
          tlog,
        );
      } catch (err) {
        pendingPtys.delete(terminalId);
        throw err;
      }

      const ptyId = result.ptyId;
      const pendingPty = pendingPtys.get(ptyId);
      pendingPtys.delete(terminalId);
      if (ptyId !== terminalId) {
        pendingPtys.delete(ptyId);
        throw new Error(
          `remote helper returned unexpected PTY id ${ptyId} for ${terminalId}`,
        );
      }
      let currentCwd = result.cwd;
      let currentProcess = result.process ?? "";
      let currentForegroundPid = result.foregroundPid;
      let disposed = false;
      let screen: PtyScreen | null = null;

      function writeRemote(data: string): void {
        void sendRequest("write", { ptyId, data }, tlog).catch((err) =>
          tlog.error({ err, host: summary.id }, "remote pty write failed"),
        );
      }

      screen = createPtyScreen(
        tlog,
        {
          ...opts,
          onCwd: (newCwd) => {
            currentCwd = newCwd;
            opts.onCwd?.(newCwd);
          },
        },
        writeRemote,
      );

      const reg: PtyEventHandlers = {
        onData: (event) => {
          currentProcess = event.params.process ?? currentProcess;
          currentForegroundPid =
            event.params.foregroundPid ?? currentForegroundPid;
          screen?.writeOutput(event.params.data);
        },
        onExit: (event) => {
          if (disposed) return;
          disposed = true;
          ptys.delete(ptyId);
          screen?.dispose();
          opts.onExit(event.params.exitCode);
          maybeShutdown();
        },
      };
      ptys.set(ptyId, reg);
      if (pendingPty?.overflowed) {
        tlog.error(
          { host: summary.id, ptyId },
          "remote pty dropped output before spawn response",
        );
      }
      for (const event of pendingPty?.events ?? []) {
        if (event.method === "data") reg.onData(event);
        else reg.onExit(event);
        if (disposed) break;
      }

      return {
        pid: result.pid,
        get cwd() {
          return currentCwd;
        },
        get process() {
          return currentProcess;
        },
        get foregroundPid() {
          return currentForegroundPid;
        },
        write: writeRemote,
        resize: (cols, rows) => {
          screen?.resize(cols, rows);
          void sendRequest("resize", { ptyId, cols, rows }, tlog).catch((err) =>
            tlog.error({ err, host: summary.id }, "remote pty resize failed"),
          );
        },
        getScreenState: () => screen?.getScreenState() ?? "",
        getScreenText: (startLine?: number, endLine?: number) =>
          screen?.getScreenText(startLine, endLine) ?? "",
        dispose() {
          if (disposed) return;
          disposed = true;
          ptys.delete(ptyId);
          screen?.dispose();
          void sendRequest("dispose", { ptyId }, tlog)
            .catch((err) =>
              tlog.error(
                { err, host: summary.id },
                "remote pty dispose failed",
              ),
            )
            .finally(maybeShutdown);
        },
      };
    },
    shutdown() {
      child?.kill();
      child = null;
      helperReady = false;
      pendingPtys.clear();
      ptys.clear();
      agentWatchers.clear();
      rejectAll(new Error(`remote host ${summary.id} shut down`));
    },
  };
}
