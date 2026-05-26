/**
 * Terminal lifecycle: spawn PTYs, wire them to metadata providers, and
 * manage create/kill/update operations. The underlying `Map` and its
 * simple accessors (`getTerminal`, `listTerminals`, `terminalCount`,
 * `countActiveClaudeSessions`, the `TerminalProcess` shape) live in
 * `./terminal-registry.ts` so `./meta/*` can depend on the registry
 * without closing a cycle back through this file.
 *
 * External callers that used to import state-reads + lifecycle from
 * `./terminals.ts` as a single module keep their import path — this
 * file re-exports the registry surface they need.
 */

import {
  DEFAULT_TERMINAL_LOCATION,
  type InitialTerminalMetadata,
  type RightPanelPerTerminalState,
  type SavedTerminal,
  type TerminalId,
  type TerminalInfo,
  type TerminalLocation,
} from "kolu-common/surface";
import { DEFAULT_SCROLLBACK } from "kolu-common/config";
import {
  agentPtyProvider,
  localPtyProvider,
  type PtyProvider,
  sshPtyProvider,
} from "kolu-pty";
import { getHostSession } from "./agent/host-registry.ts";
import pkg from "../package.json" with { type: "json" };
import { cleanupClipboardDir } from "./clipboard.ts";
import { koluShellDir } from "./koluRoot.ts";
import { log } from "./log.ts";
import {
  createMetadata,
  startProviders,
  updateClientMetadata,
  updateServerLiveMetadata,
  updateServerMetadata,
} from "./meta/index.ts";
import { terminalChannels, terminalsDirtyChannel } from "./publisher.ts";
import { surfaceCtx } from "./surface.ts";
import {
  drainTerminals,
  getTerminal,
  listTerminals,
  registerTerminal,
  type TerminalProcess,
  terminalEntries,
  unregisterTerminal,
} from "./terminal-registry.ts";

// Re-export registry accessors + type so external callers (router.ts,
// diagnostics.ts, index.ts) keep a single import path.
export {
  countActiveClaudeSessions,
  getTerminal,
  listTerminals,
  type TerminalProcess,
  terminalCount,
} from "./terminal-registry.ts";

/** Build a session snapshot from current terminal state.
 *
 *  The persisted fields live on `TerminalMetadata` in the exact shape
 *  `SavedTerminal` needs — so a snapshot is "strip the live fields,
 *  add id". Adding a future persisted field to
 *  `PersistedTerminalFieldsSchema` flows through here with no change.
 *  Order is `Map` insertion order — terminals appear in the sequence
 *  they were created. */
export function snapshotSession(): {
  terminals: SavedTerminal[];
  activeTerminalId: string | null;
} {
  const snappedTerminals = [...terminalEntries()].map(
    ([id, entry]): SavedTerminal => {
      const {
        pr: _pr,
        agent: _agent,
        foreground: _foreground,
        connectionState: _connectionState,
        ...persisted
      } = entry.meta;
      return { id, ...persisted };
    },
  );
  return { terminals: snappedTerminals, activeTerminalId };
}

/** Notify that terminal state changed (triggers debounced session auto-save). */
function emitChanged(): void {
  terminalsDirtyChannel.publish({});
}

/** Notify that terminal membership changed (create/kill).
 *  Drives the live `surface.terminalList.get` stream to clients. The
 *  surface owns the publish channel; calling `set` triggers the
 *  framework's apply+publish chain (the `terminalList` cell's store is a
 *  no-op since the registry is canonical). */
function emitListChanged(): void {
  surfaceCtx.cells.terminalList.set(listTerminals());
}

/** Create a new terminal, spawn a PTY process. `initial` seeds
 *  client-owned metadata before `startProviders` runs, so the first
 *  `terminalMetadata` collection read carries it — used by session
 *  restore to avoid racing post-hoc `setCanvasLayout` / `setTheme` /
 *  `setSubPanel` RPCs against the client's canvas-cascade effect (#642). */
export function createTerminal(
  cwd?: string,
  parentId?: string,
  initial?: InitialTerminalMetadata,
  /** Explicit location override — passed by the SSH host picker. When
   *  set, takes precedence over the parent's location. For sub-terminals
   *  (no explicit location, parentId set) the server inherits the
   *  parent's location instead. */
  explicitLocation?: TerminalLocation,
): TerminalInfo {
  const id = crypto.randomUUID();
  const tlog = log.child({ terminal: id });

  // Location resolution order: explicit (from API caller) → parent's
  // (sub-terminal inheritance, Phase 0) → DEFAULT (local).
  const parentEntry = parentId ? getTerminal(parentId) : undefined;
  const location: TerminalLocation =
    explicitLocation ?? parentEntry?.meta.location ?? DEFAULT_TERMINAL_LOCATION;

  // Phase 3: SSH terminals use `agentPtyProvider` so the PTY lives on
  // the remote `kolu-remote-agent` and survives ssh drops. Phase 1's
  // `sshPtyProvider` is the fallback when the agent isn't reachable —
  // for now controlled by `KOLU_REMOTE_PTY_VIA_AGENT=1` so we can ship
  // the Phase 3 wiring without forcing users onto the agent path
  // before the agent's `terminal.spawn` handler is fully implemented.
  let ptyProvider: PtyProvider;
  if (location.kind === "ssh") {
    if (process.env.KOLU_REMOTE_PTY_VIA_AGENT === "1") {
      const cached = getHostSession(location.host, log);
      ptyProvider = agentPtyProvider({
        host: location.host,
        session: {
          call: async (method, args) => {
            await cached.ready;
            return cached.session.call(method, args);
          },
          subscribe: (method, args, onEvent) => {
            // Same defer-until-ready wrapper used by meta/git.ts; the
            // talk-plan's "HostSession owns subscription lifetime" win
            // applies identically for PTY streams.
            let inner: ReturnType<typeof cached.session.subscribe> | null =
              null;
            const queuedUpdates: unknown[] = [];
            let closed = false;
            void cached.ready.then(() => {
              if (closed) return;
              inner = cached.session.subscribe(method, args, onEvent);
              for (const p of queuedUpdates) void inner.update(p);
            });
            return {
              update: async (p) => {
                if (inner) await inner.update(p);
                else queuedUpdates.push(p);
              },
              close: async () => {
                closed = true;
                if (inner) await inner.close();
              },
            };
          },
        },
        // Reuse the remoteSessionId persisted from the prior run if
        // session restore is replaying this terminal.
        remoteSessionId: undefined,
        onSessionAllocated: (rid) => {
          const entry = getTerminal(id);
          if (entry) {
            updateServerMetadata(entry, id, (m) => {
              m.remoteSessionId = rid;
            });
          }
        },
      });
    } else {
      ptyProvider = sshPtyProvider(location.host);
    }
  } else {
    ptyProvider = localPtyProvider;
  }

  const handle = ptyProvider.spawn(
    tlog,
    id,
    {
      rcDir: koluShellDir,
      termProgramVersion: pkg.version,
      scrollback: DEFAULT_SCROLLBACK,
      onData: (data) => {
        // SSH terminals transition connecting → live on the first byte
        // of remote output (matches the user's mental model: "the
        // remote shell has shown me something, the connection works").
        // No-op for already-live terminals.
        if (location.kind !== "local") {
          const entry = getTerminal(id);
          if (entry && entry.meta.connectionState === "connecting") {
            updateServerLiveMetadata(entry, id, (m) => {
              m.connectionState = "live";
            });
          }
        }
        terminalChannels.data(id).publish(data);
      },
      // On natural exit: notify clients, then remove from server state
      onExit: (exitCode) => {
        tlog.info({ exitCode }, "exited");
        const entry = getTerminal(id);
        if (entry) {
          // For SSH terminals, surface the connection drop in
          // connectionState before tearing down — the client renders a
          // disconnected overlay on the tile. Local terminals don't
          // need this (the exit toast covers it).
          if (location.kind !== "local") {
            updateServerLiveMetadata(entry, id, (m) => {
              m.connectionState = "disconnected";
            });
          }
          entry.stopProviders();
          cleanupClipboardDir(id);
        }
        surfaceCtx.events.terminalExit.publish({ id }, exitCode);
        // Only save session on natural exit (entry still in map).
        // killAllTerminals clears the map first, so entry is gone — skip.
        const wasNaturalExit = unregisterTerminal(id);
        if (wasNaturalExit) {
          emitChanged();
          emitListChanged();
        }
      },
      // PTY callback (OSC 0/2): notify process provider that title changed
      onTitleChange: (title) => {
        terminalChannels.title(id).publish(title);
      },
      // PTY callback (OSC 633;E): raw preexec command line. Agent parsing,
      // the per-terminal stash, and the recent-agents MRU all live in
      // `meta/agent-command.ts`, fed via this channel.
      onCommandRun: (raw) => {
        terminalChannels.commandRun(id).publish(raw);
      },
      // PTY callback (OSC 7): update metadata CWD, notify providers via cwd channel
      onCwd: (newCwd) => {
        const entry = getTerminal(id);
        if (entry) {
          updateServerMetadata(entry, id, (m) => {
            m.cwd = newCwd;
          });
          terminalChannels.cwd(id).publish(newCwd);
        }
      },
    },
    cwd,
  );

  const meta = createMetadata(handle.cwd, location);
  if (parentId) meta.parentId = parentId;
  // Seed client-owned initial metadata BEFORE startProviders so the first
  // `terminalMetadata` collection yield carries these fields (see #642).
  if (initial?.themeName) meta.themeName = initial.themeName;
  if (initial?.canvasLayout) meta.canvasLayout = initial.canvasLayout;
  if (initial?.subPanel) meta.subPanel = initial.subPanel;
  if (initial?.rightPanel) meta.rightPanel = initial.rightPanel;
  if (initial?.lastActivityAt !== undefined)
    meta.lastActivityAt = initial.lastActivityAt;
  if (initial?.intent) meta.intent = initial.intent;
  const entry: TerminalProcess = {
    info: { id },
    meta,
    handle,
    stopProviders: () => {},
  };
  // Start providers after entry is in the map (providers may emit immediately)
  registerTerminal(id, entry);
  entry.stopProviders = startProviders(entry, id);

  tlog.info({ pid: handle.pid, total: listTerminals().length }, "created");
  emitChanged();
  emitListChanged();
  return entry.info;
}

/** Kill a terminal's PTY process and remove it from the map. Returns final info, or undefined if not found. */
export function killTerminal(id: TerminalId): TerminalInfo | undefined {
  const entry = getTerminal(id);
  if (!entry) return undefined;

  log.child({ terminal: id }).info({ pid: entry.handle.pid }, "killing");
  entry.stopProviders();
  entry.handle.dispose();
  cleanupClipboardDir(id);
  unregisterTerminal(id);
  emitChanged();
  emitListChanged();
  return entry.info;
}

/** Set or clear a terminal's parent relationship. */
export function setTerminalParent(
  id: TerminalId,
  parentId: string | null,
): void {
  const entry = getTerminal(id);
  if (entry) {
    const newParent = parentId ?? undefined;
    updateClientMetadata(entry, id, (m) => {
      m.parentId = newParent;
    });
  }
}

/** Store a terminal's canvas layout position (client-reported).
 *  Publishes via metadata so canvas tiles read their position from the
 *  same source as other metadata — no client-side dual store required. */
export function setCanvasLayout(
  id: TerminalId,
  layout: { x: number; y: number; w: number; h: number },
): void {
  const entry = getTerminal(id);
  if (!entry) return;
  updateClientMetadata(entry, id, (m) => {
    m.canvasLayout = layout;
  });
}

/** Store a terminal's sub-panel state (client-reported).
 *  Publishes via metadata so other clients (and the same client after a
 *  refresh, via the collection's snapshot read) pick up the change from
 *  the same channel as every other client-owned metadata field.
 *
 *  Equality-gated: the client RPCs this on every drag tick of the
 *  resizable handle, so without a guard each mouse-move would fan a
 *  full per-key metadata publish to every connected client. Same shape
 *  as `meta/agent-command.ts`'s `lastAgentCommand` gate. */
export function setSubPanelState(
  id: TerminalId,
  state: { collapsed: boolean; panelSize: number },
): void {
  const entry = getTerminal(id);
  if (!entry) return;
  const cur = entry.meta.subPanel;
  if (
    cur &&
    cur.collapsed === state.collapsed &&
    cur.panelSize === state.panelSize
  )
    return;
  updateClientMetadata(entry, id, (m) => {
    m.subPanel = state;
  });
}

/** Store a terminal's right-panel per-terminal state (client-reported).
 *  Publishes via metadata so other clients (and the same client after a
 *  refresh) pick up the change from the same channel as every other
 *  client-owned metadata field.
 *
 *  Equality-gated like `setSubPanelState` — the client RPCs this on every
 *  file-tree click and tab-toggle, so without a guard each interaction
 *  would fan a full per-key metadata publish. Deep-compares
 *  `selectedFileByMode` since the user clicks files often. */
export function setRightPanelState(
  id: TerminalId,
  state: RightPanelPerTerminalState,
): void {
  const entry = getTerminal(id);
  if (!entry) return;
  const cur = entry.meta.rightPanel;
  if (cur && rightPanelStateEqual(cur, state)) return;
  updateClientMetadata(entry, id, (m) => {
    m.rightPanel = state;
  });
}

function rightPanelStateEqual(
  a: RightPanelPerTerminalState,
  b: RightPanelPerTerminalState,
): boolean {
  if (a.activeTab !== b.activeTab || a.codeMode !== b.codeMode) return false;
  const am = a.selectedFileByMode;
  const bm = b.selectedFileByMode;
  if (am === bm) return true;
  if (!am || !bm) return false;
  if (am.local !== bm.local) return false;
  if (am.branch !== bm.branch) return false;
  if (am.browse !== bm.browse) return false;
  return true;
}

// Active terminal ID — client-reported, used only for session snapshots.
let activeTerminalId: TerminalId | null = null;

/** Store which terminal is active (reported by the client).
 *  Only emits session:changed when a terminal is actually selected —
 *  null (no selection, e.g. client reconnect) must not trigger auto-save
 *  because snapshotSession() may return an empty terminal list at that
 *  point, which would clear the saved session. */
export function setActiveTerminalId(id: TerminalId | null): void {
  activeTerminalId = id;
  if (id !== null) emitChanged();
}

/** Set the theme name for a terminal (stored in metadata, published to clients). */
export function setTerminalTheme(id: TerminalId, themeName: string): void {
  const entry = getTerminal(id);
  if (entry) {
    updateClientMetadata(entry, id, (m) => {
      m.themeName = themeName;
    });
  }
}

/** Set or clear a terminal's freeform intent annotation. Empty string clears. */
export function setTerminalIntent(id: TerminalId, intent: string): void {
  const entry = getTerminal(id);
  if (!entry) return;
  const next = intent.length > 0 ? intent : undefined;
  updateClientMetadata(entry, id, (m) => {
    m.intent = next;
  });
}

/** Kill and remove all terminals. Used by tests to reset server state between scenarios. */
export function killAllTerminals(): void {
  // Snapshot entries and clear map BEFORE disposing — prevents onExit
  // callbacks from finding terminals and triggering session saves.
  const entries = drainTerminals();
  log.info({ count: entries.length }, "killing all terminals");
  for (const entry of entries) {
    entry.stopProviders();
    entry.handle.dispose();
    cleanupClipboardDir(entry.info.id);
  }
  emitListChanged();
}
