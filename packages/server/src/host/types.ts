import type { HostSummary } from "kolu-common/contract";
import type { AgentInfo, AgentKind } from "kolu-common/surface";
import type {
  GitDiffMode,
  GitDiffOutput,
  GitInfo,
  GitResult,
  GitStatusOutput,
} from "kolu-git";
import type { Logger } from "../log.ts";
import type { PtyCallbacks, PtyHandle } from "../pty.ts";

export interface HostGitInfoSubscription {
  setCwd(next: string): void;
  stop(): void;
}

export interface HostAgentState {
  foregroundPid: number | undefined;
  cwd: string;
  foregroundProcess: string | null;
  lastAgentCommandName: string | null;
}

export interface HostAgentWatch {
  update(state: HostAgentState): void;
  stop(): void;
}

export interface HostReadFileOutput {
  content: string;
  truncated: boolean;
}

/** Terminal execution host. Local and SSH hosts both expose terminal IO plus
 *  the host-local repository/file/agent reads that belong to that terminal's
 *  filesystem. */
export interface Host {
  readonly summary?: HostSummary;
  spawnPty(
    tlog: Logger,
    terminalId: string,
    opts: PtyCallbacks,
    cwd?: string,
  ): Promise<PtyHandle>;
  subscribeGitInfo(
    initialCwd: string,
    onChange: (info: GitInfo | null) => void,
    log?: Logger,
  ): HostGitInfoSubscription;
  getStatus(
    repoPath: string,
    mode: GitDiffMode,
    log?: Logger,
  ): Promise<GitResult<GitStatusOutput>>;
  getDiff(
    repoPath: string,
    filePath: string,
    mode: GitDiffMode,
    log?: Logger,
    oldPath?: string,
  ): Promise<GitResult<GitDiffOutput>>;
  listAll(repoPath: string, log?: Logger): Promise<GitResult<string[]>>;
  readFile(
    repoPath: string,
    filePath: string,
    log?: Logger,
  ): Promise<GitResult<HostReadFileOutput>>;
  subscribeRepoChange(
    repoRoot: string,
    onChange: () => void,
    log?: Logger,
  ): () => void;
  subscribeFileChange(
    repoRoot: string,
    filePath: string,
    onChange: () => void,
    log?: Logger,
  ): () => void;
  watchAgent?(
    kind: AgentKind,
    state: HostAgentState,
    onChange: (info: AgentInfo | null) => void,
    log?: Logger,
  ): HostAgentWatch;
  shutdown(): void;
}
