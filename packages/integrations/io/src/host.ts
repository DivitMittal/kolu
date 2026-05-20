import type { Executor } from "./executor.ts";

export interface HostLogger {
  debug: (obj: Record<string, unknown>, msg: string) => void;
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

export interface HostPtyHandle {
  readonly pid: number;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  getScreenState(): string;
  getScreenText(startLine?: number, endLine?: number): string;
  dispose(): void;
}

export interface HostSpawnPtyOpts {
  rcDir: string;
  termProgramVersion: string;
  scrollback: number;
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
  onCwd?: (cwd: string) => void;
  onTitleChange?: (title: string) => void;
  onCommandRun?: (command: string) => void;
}

export interface Host extends Executor {
  readonly label: string;
  spawnPty(log: HostLogger, opts: HostSpawnPtyOpts): Promise<HostPtyHandle>;
  shutdown(): Promise<void>;
}
