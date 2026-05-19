import type { AgentKind } from "kolu-common/surface";
import type { HostAgentWatch } from "../host/types.ts";
import { log } from "../log.ts";
import { terminalChannels } from "../publisher.ts";
import type { TerminalProcess } from "../terminal-registry.ts";
import { setAgentMetadata, snapshotHostAgentState } from "./agent.ts";

const COMMAND_RUN_RECONCILE_DELAYS_MS = [0, 75, 300, 1000] as const;

export function startRemoteAgentProvider(
  kind: AgentKind,
  entry: TerminalProcess,
  terminalId: string,
): () => void {
  const plog = log.child({ provider: kind, terminal: terminalId });
  if (!entry.host.watchAgent) {
    plog.warn("remote host does not support agent watching");
    return () => {};
  }
  const startWatch: NonNullable<TerminalProcess["host"]["watchAgent"]> =
    entry.host.watchAgent;

  let current: HostAgentWatch | null = null;
  let stopped = false;
  let commandRunTimers: ReturnType<typeof setTimeout>[] = [];

  function reconcile(): void {
    if (stopped) return;
    const state = snapshotHostAgentState(entry, terminalId, plog);
    if (current) {
      current.update(state);
      return;
    }
    current = startWatch.call(
      entry.host,
      kind,
      state,
      (info) => {
        if (stopped) return;
        if (info === null && entry.meta.agent?.kind !== kind) return;
        setAgentMetadata(entry, terminalId, info);
      },
      plog,
    );
  }

  function clearCommandRunTimers(): void {
    for (const timer of commandRunTimers) clearTimeout(timer);
    commandRunTimers = [];
  }

  function reconcileFromCommandRun(idx: number): void {
    if (stopped) return;
    try {
      reconcile();
    } catch (err) {
      plog.error({ err }, "remote command-run reconcile failed");
    }
    const nextIdx = idx + 1;
    const next = COMMAND_RUN_RECONCILE_DELAYS_MS[nextIdx];
    if (next === undefined) return;
    const cur = COMMAND_RUN_RECONCILE_DELAYS_MS[idx];
    if (cur === undefined) return;
    commandRunTimers.push(
      setTimeout(() => reconcileFromCommandRun(nextIdx), next - cur),
    );
  }

  function scheduleCommandRunReconciles(): void {
    clearCommandRunTimers();
    reconcileFromCommandRun(0);
  }

  const cleanupTitle = terminalChannels.title(terminalId).consume({
    onEvent: () => reconcile(),
    onError: (err) => plog.error({ err }, "publisher subscription failed"),
  });
  const cleanupCwd = terminalChannels.cwd(terminalId).consume({
    onEvent: () => reconcile(),
    onError: (err) => plog.error({ err }, "publisher subscription failed"),
  });
  const cleanupCommandRun = terminalChannels.commandRun(terminalId).consume({
    onEvent: () => scheduleCommandRunReconciles(),
    onError: (err) => plog.error({ err }, "publisher subscription failed"),
  });

  reconcile();

  return () => {
    stopped = true;
    clearCommandRunTimers();
    cleanupTitle();
    cleanupCwd();
    cleanupCommandRun();
    current?.stop();
    plog.debug("stopped");
  };
}
