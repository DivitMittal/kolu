/**
 * NDJSON protocol between the Kolu server and `kolu-helper` over SSH stdio.
 *
 * This protocol covers the host-local operations that a remote terminal needs
 * to behave like a local one: PTY lifecycle, git/file reads for the Code tab,
 * and agent-session detection/watch events. Keep it method-keyed and typed;
 * do not turn it into a generic remote shell escape hatch.
 */

import {
  GitDiffModeSchema,
  type GitDiffOutput,
  GitDiffOutputSchema,
  type GitInfo,
  GitInfoSchema,
  type GitStatusOutput,
  GitStatusOutputSchema,
} from "kolu-git";
import { z } from "zod";
import {
  type AgentInfo,
  AgentInfoSchema,
  AgentKindSchema,
  type AgentKind,
} from "./surface.ts";

/** Increment when the helper wire protocol changes incompatibly. */
export const HELPER_PROTOCOL_VERSION = 2;

const PositiveIntSchema = z.number().int().positive();

/** Process status fields piggybacked on PTY data frames. */
export const HelperPtyStatusSchema = z.object({
  process: z.string().optional(),
  foregroundPid: z.number().int().positive().optional(),
});

/** Request payload for spawning one remote PTY. */
export const HelperSpawnPtyParamsSchema = z.object({
  terminalId: z.string(),
  cwd: z.string().optional(),
  cols: PositiveIntSchema,
  rows: PositiveIntSchema,
});
export type HelperSpawnPtyParams = z.infer<typeof HelperSpawnPtyParamsSchema>;

/** Request payload for writing bytes to an existing remote PTY. */
export const HelperWriteParamsSchema = z.object({
  ptyId: z.string(),
  data: z.string(),
});
export type HelperWriteParams = z.infer<typeof HelperWriteParamsSchema>;

/** Request payload for resizing an existing remote PTY. */
export const HelperResizeParamsSchema = z.object({
  ptyId: z.string(),
  cols: PositiveIntSchema,
  rows: PositiveIntSchema,
});
export type HelperResizeParams = z.infer<typeof HelperResizeParamsSchema>;

/** Request payload for disposing an existing remote PTY. */
export const HelperDisposeParamsSchema = z.object({
  ptyId: z.string(),
});
export type HelperDisposeParams = z.infer<typeof HelperDisposeParamsSchema>;

export const HelperResolveGitInfoParamsSchema = z.object({
  cwd: z.string(),
});
export type HelperResolveGitInfoParams = z.infer<
  typeof HelperResolveGitInfoParamsSchema
>;
export type HelperResolveGitInfoResult = GitInfo | null;
export const HelperResolveGitInfoResultSchema = GitInfoSchema.nullable();

export const HelperGitStatusParamsSchema = z.object({
  repoPath: z.string(),
  mode: GitDiffModeSchema,
});
export type HelperGitStatusParams = z.infer<typeof HelperGitStatusParamsSchema>;

export const HelperGitDiffParamsSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
  mode: GitDiffModeSchema,
  oldPath: z.string().optional(),
});
export type HelperGitDiffParams = z.infer<typeof HelperGitDiffParamsSchema>;

export const HelperFsListAllParamsSchema = z.object({
  repoPath: z.string(),
});
export type HelperFsListAllParams = z.infer<typeof HelperFsListAllParamsSchema>;

export const HelperFsListAllResultSchema = z.object({
  paths: z.array(z.string()),
});
export type HelperFsListAllResult = z.infer<typeof HelperFsListAllResultSchema>;

export const HelperFsReadFileParamsSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
});
export type HelperFsReadFileParams = z.infer<
  typeof HelperFsReadFileParamsSchema
>;

export const HelperFsReadFileResultSchema = z.object({
  content: z.string(),
  truncated: z.boolean(),
});
export type HelperFsReadFileResult = z.infer<
  typeof HelperFsReadFileResultSchema
>;

export const HelperAgentStateSchema = z.object({
  foregroundPid: z.number().int().positive().optional(),
  cwd: z.string(),
  foregroundProcess: z.string().nullable(),
  lastAgentCommandName: z.string().nullable(),
});
export type HelperAgentState = z.infer<typeof HelperAgentStateSchema>;

export const HelperWatchAgentParamsSchema = z.object({
  watchId: z.string(),
  kind: AgentKindSchema,
  state: HelperAgentStateSchema,
});
export type HelperWatchAgentParams = z.infer<
  typeof HelperWatchAgentParamsSchema
>;

export const HelperWatchAgentResultSchema = z.object({
  sessionKey: z.string().nullable(),
});
export type HelperWatchAgentResult = z.infer<
  typeof HelperWatchAgentResultSchema
>;

export const HelperUnwatchAgentParamsSchema = z.object({
  watchId: z.string(),
});
export type HelperUnwatchAgentParams = z.infer<
  typeof HelperUnwatchAgentParamsSchema
>;

const HelperRequestIdSchema = z.number().int().nonnegative();

/** Helper request method names. */
export const HelperRpcMethodSchema = z.enum([
  "spawnPty",
  "write",
  "resize",
  "dispose",
  "resolveGitInfo",
  "gitStatus",
  "gitDiff",
  "fsListAll",
  "fsReadFile",
  "watchAgent",
  "unwatchAgent",
]);
export type HelperRpcMethod = z.infer<typeof HelperRpcMethodSchema>;

/** Helper response payload for a successful spawn. */
export const HelperSpawnPtyResultSchema = z
  .object({
    ptyId: z.string(),
    pid: z.number().int(),
    cwd: z.string(),
  })
  .merge(HelperPtyStatusSchema);
export type HelperSpawnPtyResult = z.infer<typeof HelperSpawnPtyResultSchema>;

/** Method-keyed helper RPC contract. */
export interface HelperRpcSpec {
  spawnPty: {
    params: HelperSpawnPtyParams;
    result: HelperSpawnPtyResult;
  };
  write: {
    params: HelperWriteParams;
    result: null;
  };
  resize: {
    params: HelperResizeParams;
    result: null;
  };
  dispose: {
    params: HelperDisposeParams;
    result: null;
  };
  resolveGitInfo: {
    params: HelperResolveGitInfoParams;
    result: HelperResolveGitInfoResult;
  };
  gitStatus: {
    params: HelperGitStatusParams;
    result: GitStatusOutput;
  };
  gitDiff: {
    params: HelperGitDiffParams;
    result: GitDiffOutput;
  };
  fsListAll: {
    params: HelperFsListAllParams;
    result: HelperFsListAllResult;
  };
  fsReadFile: {
    params: HelperFsReadFileParams;
    result: HelperFsReadFileResult;
  };
  watchAgent: {
    params: HelperWatchAgentParams;
    result: HelperWatchAgentResult;
  };
  unwatchAgent: {
    params: HelperUnwatchAgentParams;
    result: null;
  };
}

export type HelperParams<M extends HelperRpcMethod> =
  HelperRpcSpec[M]["params"];
export type HelperResult<M extends HelperRpcMethod> =
  HelperRpcSpec[M]["result"];

/** Discriminated helper request frame. */
export const HelperRequestSchema = z.discriminatedUnion("method", [
  z.object({
    id: HelperRequestIdSchema,
    method: z.literal("spawnPty"),
    params: HelperSpawnPtyParamsSchema,
  }),
  z.object({
    id: HelperRequestIdSchema,
    method: z.literal("write"),
    params: HelperWriteParamsSchema,
  }),
  z.object({
    id: HelperRequestIdSchema,
    method: z.literal("resize"),
    params: HelperResizeParamsSchema,
  }),
  z.object({
    id: HelperRequestIdSchema,
    method: z.literal("dispose"),
    params: HelperDisposeParamsSchema,
  }),
  z.object({
    id: HelperRequestIdSchema,
    method: z.literal("resolveGitInfo"),
    params: HelperResolveGitInfoParamsSchema,
  }),
  z.object({
    id: HelperRequestIdSchema,
    method: z.literal("gitStatus"),
    params: HelperGitStatusParamsSchema,
  }),
  z.object({
    id: HelperRequestIdSchema,
    method: z.literal("gitDiff"),
    params: HelperGitDiffParamsSchema,
  }),
  z.object({
    id: HelperRequestIdSchema,
    method: z.literal("fsListAll"),
    params: HelperFsListAllParamsSchema,
  }),
  z.object({
    id: HelperRequestIdSchema,
    method: z.literal("fsReadFile"),
    params: HelperFsReadFileParamsSchema,
  }),
  z.object({
    id: HelperRequestIdSchema,
    method: z.literal("watchAgent"),
    params: HelperWatchAgentParamsSchema,
  }),
  z.object({
    id: HelperRequestIdSchema,
    method: z.literal("unwatchAgent"),
    params: HelperUnwatchAgentParamsSchema,
  }),
]);

/** Method-keyed response validators. */
export const HelperResultSchemaByMethod = {
  spawnPty: HelperSpawnPtyResultSchema,
  write: z.null(),
  resize: z.null(),
  dispose: z.null(),
  resolveGitInfo: HelperResolveGitInfoResultSchema,
  gitStatus: GitStatusOutputSchema,
  gitDiff: GitDiffOutputSchema,
  fsListAll: HelperFsListAllResultSchema,
  fsReadFile: HelperFsReadFileResultSchema,
  watchAgent: HelperWatchAgentResultSchema,
  unwatchAgent: z.null(),
} satisfies {
  [M in HelperRpcMethod]: z.ZodType<HelperResult<M>>;
};

/** Parse the response payload for a known request method. */
export function parseHelperResult<M extends HelperRpcMethod>(
  method: M,
  result: unknown,
): HelperResult<M> {
  return HelperResultSchemaByMethod[method].parse(result) as HelperResult<M>;
}

/** Error payload returned by the helper for failed requests. */
export const HelperErrorShapeSchema = z.object({
  kind: z.enum(["not-found", "spawn-failed", "invalid", "internal"]),
  message: z.string(),
});
export type HelperErrorShape = z.infer<typeof HelperErrorShapeSchema>;

const HelperResponseResultSchema = z.union([
  HelperSpawnPtyResultSchema,
  HelperResolveGitInfoResultSchema,
  GitStatusOutputSchema,
  GitDiffOutputSchema,
  HelperFsListAllResultSchema,
  HelperFsReadFileResultSchema,
  HelperWatchAgentResultSchema,
  z.null(),
]);

export const HelperResponseSchema = z
  .object({
    id: HelperRequestIdSchema,
    result: HelperResponseResultSchema.optional(),
    error: HelperErrorShapeSchema.optional(),
  })
  .refine((frame) => frame.result !== undefined || frame.error !== undefined, {
    message: "helper response must include result or error",
  });

/** Helper startup event, including protocol compatibility metadata. */
export const HelperReadyEventSchema = z.object({
  method: z.literal("ready"),
  params: z.object({
    version: z.string(),
    protocolVersion: z.number().int().positive(),
  }),
});

/** Helper PTY output event. */
export const HelperDataEventSchema = z.object({
  method: z.literal("data"),
  params: z
    .object({
      ptyId: z.string(),
      data: z.string(),
    })
    .merge(HelperPtyStatusSchema),
});

/** Helper PTY exit event. */
export const HelperExitEventSchema = z.object({
  method: z.literal("exit"),
  params: z.object({
    ptyId: z.string(),
    exitCode: z.number().int(),
  }),
});

export const HelperAgentEventSchema = z.object({
  method: z.literal("agent"),
  params: z.object({
    watchId: z.string(),
    info: AgentInfoSchema.nullable(),
  }),
});

export const HelperEventSchema = z.union([
  HelperReadyEventSchema,
  HelperDataEventSchema,
  HelperExitEventSchema,
  HelperAgentEventSchema,
]);
export type HelperEvent = z.infer<typeof HelperEventSchema>;
export type HelperDataEvent = z.infer<typeof HelperDataEventSchema>;
export type HelperExitEvent = z.infer<typeof HelperExitEventSchema>;
export type HelperAgentEvent = z.infer<typeof HelperAgentEventSchema>;
export type { AgentInfo, AgentKind };
