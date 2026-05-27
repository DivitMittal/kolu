/**
 * `agentSurface` — the typed wire shape `kolu --stdio` agents serve over
 * stdio. The parent's `RemoteTerminalBackend` consumes it; the agent
 * implements it backed by its local PTY world. Kolu's main user-facing
 * surface (`kolu-common/surface`) is a separate contract — the parent
 * re-serves that one to the browser, mirroring agent state into its own
 * `terminalMetadata` collection.
 *
 * Wire shape covers what `TerminalBackend` needs to operate over a
 * remote agent: terminal lifecycle procedures, per-terminal data
 * streams, fs/git ops, plus a heartbeat the parent's layer polls.
 *
 * **AgentTerminalMetadata is the server half** of `TerminalMetadata`
 * (cwd, git, agent, pr, foreground, lastAgentCommand, lastActivityAt).
 * UI-only state (themeName, canvasLayout, subPanel, rightPanel, intent,
 * parentId) lives on the parent side only — the agent has no business
 * knowing the user's pixel layout.
 */

import { defineSurface, type SurfaceTypes } from "@kolu/surface/define";
import {
  FsListAllOutputSchema,
  GitDiffOutputSchema,
  GitDiffModeSchema,
  GitStatusOutputSchema,
} from "kolu-git/schemas";
import { z } from "zod";
import {
  InitialTerminalMetadataSchema,
  TerminalIdSchema,
  TerminalInfoSchema,
  TerminalServerMetadataSchema,
} from "./surface.ts";

// ── Procedure I/O schemas ─────────────────────────────────────────────

const TerminalSpawnInputSchema = z.object({
  id: TerminalIdSchema,
  cwd: z.string().optional(),
  parentId: z.string().optional(),
  initialMetadata: InitialTerminalMetadataSchema.optional(),
});

const TerminalKillInputSchema = z.object({ id: TerminalIdSchema });
const TerminalWriteInputSchema = z.object({
  id: TerminalIdSchema,
  data: z.string(),
});
const TerminalResizeInputSchema = z.object({
  id: TerminalIdSchema,
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
});
const TerminalScreenStateInputSchema = z.object({ id: TerminalIdSchema });
const TerminalScreenTextInputSchema = z.object({
  id: TerminalIdSchema,
  startLine: z.number().int().optional(),
  endLine: z.number().int().optional(),
});
const TerminalChannelInputSchema = z.object({ id: TerminalIdSchema });

const RepoSubscribeInputSchema = z.object({ repoPath: z.string() });
const FileSubscribeInputSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
});

const TerminalOnExitInputSchema = z.object({ id: TerminalIdSchema });
const TerminalOnExitOutputSchema = z.number();

// Agent fs/git input shapes — the kolu-git `FsReadFileInputSchema`
// includes a `terminalId` (parent-side, used to build iframe-preview
// URLs). The agent doesn't construct URLs, so its inputs drop the
// field. The parent's `RemoteTerminalBackend.fs.readFile(repoPath,
// filePath)` already has no terminal context at the call site.
const AgentFsListAllInputSchema = z.object({ repoPath: z.string() });
const AgentFsReadFileInputSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
});
// Agent always returns text; parent layer decides whether to swap to
// a `{ kind: "binary", url }` value (URLs are parent-built).
const AgentFsReadFileOutputSchema = z.object({
  content: z.string(),
  truncated: z.boolean(),
});
const AgentGitStatusInputSchema = z.object({
  repoPath: z.string(),
  mode: GitDiffModeSchema,
});
const AgentGitDiffInputSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
  mode: GitDiffModeSchema,
  oldPath: z.string().optional(),
});

const StatFileMtimeInputSchema = z.object({
  repoPath: z.string(),
  filePath: z.string(),
});

export const agentSurface = defineSurface({
  collections: {
    /** Server-half of per-terminal metadata, keyed by terminal id. The
     *  parent mirrors this into its own `surface.terminalMetadata`
     *  collection via `mirrorRemoteCollection`. */
    terminalMetadata: {
      keySchema: TerminalIdSchema,
      schema: TerminalServerMetadataSchema,
      verbs: ["keys", "get"],
    },
  },
  streams: {
    /** Raw PTY output bytes for one terminal, high frequency. */
    terminalData: {
      inputSchema: TerminalChannelInputSchema,
      outputSchema: z.string(),
    },
    /** CWD change events (OSC 7) for one terminal. */
    terminalCwd: {
      inputSchema: TerminalChannelInputSchema,
      outputSchema: z.string(),
    },
    /** Title change events (OSC 0/2) for one terminal. */
    terminalTitle: {
      inputSchema: TerminalChannelInputSchema,
      outputSchema: z.string(),
    },
    /** Raw preexec command lines (OSC 633;E) for one terminal. */
    terminalCommandRun: {
      inputSchema: TerminalChannelInputSchema,
      outputSchema: z.string(),
    },
    /** Repo file-tree change notifications — yields void on each event. */
    fsRepoChange: {
      inputSchema: RepoSubscribeInputSchema,
      outputSchema: z.object({}),
    },
    /** Single file change notifications — yields void on each event. */
    fsFileChange: {
      inputSchema: FileSubscribeInputSchema,
      outputSchema: z.object({}),
    },
  },
  events: {
    /** Terminal process exited — fires once per terminal lifetime. */
    terminalExit: {
      inputSchema: TerminalOnExitInputSchema,
      outputSchema: TerminalOnExitOutputSchema,
    },
  },
  procedures: {
    system: {
      /** Parent's heartbeat layer polls this; returns the agent's pid. */
      heartbeat: {
        input: z.object({}),
        output: z.object({ ok: z.boolean(), pid: z.number() }),
      },
    },
    terminal: {
      spawn: {
        input: TerminalSpawnInputSchema,
        output: TerminalInfoSchema,
      },
      kill: {
        input: TerminalKillInputSchema,
        output: TerminalInfoSchema.nullable(),
      },
      write: {
        input: TerminalWriteInputSchema,
        output: z.void(),
      },
      resize: {
        input: TerminalResizeInputSchema,
        output: z.void(),
      },
      getScreenState: {
        input: TerminalScreenStateInputSchema,
        output: z.string(),
      },
      getScreenText: {
        input: TerminalScreenTextInputSchema,
        output: z.string(),
      },
    },
    fs: {
      listAll: {
        input: AgentFsListAllInputSchema,
        output: FsListAllOutputSchema,
      },
      readFile: {
        input: AgentFsReadFileInputSchema,
        output: AgentFsReadFileOutputSchema,
      },
      statFileMtimeMs: {
        input: StatFileMtimeInputSchema,
        output: z.number(),
      },
    },
    git: {
      getStatus: {
        input: AgentGitStatusInputSchema,
        output: GitStatusOutputSchema,
      },
      getDiff: {
        input: AgentGitDiffInputSchema,
        output: GitDiffOutputSchema,
      },
    },
  },
});

type AgentSurface = SurfaceTypes<typeof agentSurface.spec>;
export type AgentTerminalMetadata =
  AgentSurface["collections"]["terminalMetadata"]["Value"];
export type AgentContract = typeof agentSurface.contract;
