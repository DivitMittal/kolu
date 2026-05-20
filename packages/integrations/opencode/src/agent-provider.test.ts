import type { AgentTerminalState } from "anyagent";
import type { Executor } from "kolu-io";
import type { Logger } from "kolu-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";

const findSessionMock = vi.fn();

vi.mock("./core.ts", () => ({
  findSessionByDirectory: (dir: string, executor: Executor, log?: Logger) =>
    findSessionMock(dir, executor, log),
}));
vi.mock("./session-watcher.ts", () => ({ createOpenCodeWatcher: vi.fn() }));

const { opencodeProvider } = await import("./agent-provider.ts");

const noopLog: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/** Stub executor — the provider only forwards it; the mocked
 *  `findSessionByDirectory` never inspects its shape. */
const stubExecutor = {} as Executor;

function makeState(over: Partial<AgentTerminalState>): AgentTerminalState {
  return {
    foregroundPid: 1000,
    cwd: "/repo",
    readForegroundBasename: () => null,
    lastAgentCommandName: null,
    ...over,
  };
}

describe("opencodeProvider.resolveSession", () => {
  beforeEach(() => {
    findSessionMock.mockReset();
  });

  it("matches when the kernel basename is 'opencode' (native install)", async () => {
    findSessionMock.mockResolvedValue({ id: "s1" });
    const state = makeState({ readForegroundBasename: () => "opencode" });
    await expect(
      opencodeProvider.resolveSession(state, stubExecutor, noopLog),
    ).resolves.toEqual({ id: "s1" });
    expect(findSessionMock).toHaveBeenCalledWith(
      "/repo",
      stubExecutor,
      noopLog,
    );
  });

  it("matches when only lastAgentCommandName is 'opencode' (npm shim)", async () => {
    findSessionMock.mockResolvedValue({ id: "s2" });
    const state = makeState({
      readForegroundBasename: () => "node",
      lastAgentCommandName: "opencode",
    });
    await expect(
      opencodeProvider.resolveSession(state, stubExecutor, noopLog),
    ).resolves.toEqual({ id: "s2" });
    expect(findSessionMock).toHaveBeenCalledWith(
      "/repo",
      stubExecutor,
      noopLog,
    );
  });

  it("skips lookup when neither signal names opencode", async () => {
    const state = makeState({
      readForegroundBasename: () => "node",
      lastAgentCommandName: null,
    });
    await expect(
      opencodeProvider.resolveSession(state, stubExecutor, noopLog),
    ).resolves.toBeNull();
    expect(findSessionMock).not.toHaveBeenCalled();
  });
});
