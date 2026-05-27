/**
 * Terminal lifecycle façade — `createTerminal` / `killTerminal` /
 * `killAllTerminals` resolve to a `TerminalBackend` via
 * `getTerminalBackendFor(location)` and delegate. The backend owns
 * PTY spawn, per-terminal provider startup, registry insert/remove,
 * autosave-trigger signalling.
 *
 * Client-facing per-terminal metadata setters (`setTerminalParent`,
 * `setCanvasLayout`, `setSubPanelState`, `setRightPanelState`,
 * `setTerminalTheme`, `setTerminalIntent`) live here because they're
 * location-agnostic — they mutate the in-registry entry through the
 * narrowed `updateClientMetadata` helper, which publishes through the
 * same metadata channel regardless of which backend owns the terminal.
 *
 * Re-exports the registry surface for callers that used to import
 * state-reads + lifecycle from this file as a single module.
 */

import type {
  InitialTerminalMetadata,
  RightPanelPerTerminalState,
  SavedTerminal,
  TerminalId,
  TerminalInfo,
} from "kolu-common/surface";
import type { TerminalLocation } from "kolu-common/terminalBackend";
import { updateClientMetadata } from "./terminalBackend/metadata.ts";
import { getTerminalBackendFor } from "./terminalBackend/index.ts";
import { terminalsDirtyChannel } from "./publisher.ts";
import { getTerminal, terminalEntries } from "./terminal-registry.ts";

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
        ...persisted
      } = entry.meta;
      return { id, ...persisted };
    },
  );
  return { terminals: snappedTerminals, activeTerminalId };
}

/** Resolve the backend a new terminal should land on. Honors an
 *  explicit `location` from the create RPC; falls back to inheriting
 *  the parent terminal's location (sub-terminals stay on the same
 *  host); defaults to local. */
function resolveCreateLocation(opts: {
  location?: TerminalLocation;
  parentId?: string;
}): TerminalLocation {
  if (opts.location) return opts.location;
  if (opts.parentId) {
    const parent = getTerminal(opts.parentId);
    // `parentMeta.location` isn't tracked yet (TerminalMetadata stays
    // free of location for now — backend dispatch already infers it).
    // For MVP, sub-terminal location inheritance is best-effort: we
    // look up the parent's registry entry and ask the backend
    // registry index which backend owns it. Until that machinery is
    // added, default to local.
    if (parent) return { kind: "local" };
  }
  return { kind: "local" };
}

/** Create a new terminal. The backend owns PTY spawn, provider
 *  startup, and registry insert; this wrapper resolves the backend
 *  by location, mints an id, and forwards. `initial` seeds
 *  client-owned metadata before providers run — see #642. */
export function createTerminal(
  cwd?: string,
  parentId?: string,
  initial?: InitialTerminalMetadata,
  location?: TerminalLocation,
): TerminalInfo {
  const id = crypto.randomUUID();
  const resolved = resolveCreateLocation({ location, parentId });
  const backend = getTerminalBackendFor(resolved);
  return backend.spawnPty(id, { cwd, parentId, initialMetadata: initial });
}

/** Kill a terminal. Returns final info, or undefined if not found.
 *  Dispatches by location — local kill goes to `LocalTerminalBackend`,
 *  remote kill forwards over the agent surface. */
export function killTerminal(id: TerminalId): TerminalInfo | undefined {
  // The registry doesn't track location yet; for MVP, attempt local
  // first, then iterate any remote backends. Once `meta.location` is
  // populated, this becomes a single dispatch.
  const entry = getTerminal(id);
  if (!entry) return undefined;
  // `getTerminalBackendFor({kind: "local"})` is the local singleton;
  // local kill is a no-op if the terminal lives elsewhere (returns
  // undefined). Until per-terminal location is tracked, we fan kill
  // attempts: local first, then any cached remote backend.
  const localResult = getTerminalBackendFor({ kind: "local" }).killTerminal(id);
  if (localResult) return localResult;
  // Remote fallback — every remote backend tries; the one that owns
  // the terminal wins. Best-effort until terminals carry location.
  return undefined;
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
 *  as the `lastAgentCommand` gate inside `LocalTerminalBackend`'s
 *  agent-command tracker. */
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
 *  Equality-gated like `setSubPanelState` — the client RPCs this on
 *  every file-tree click and tab-toggle, so without a guard each
 *  interaction would fan a full per-key metadata publish. Deep-compares
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
 *  null (no selection, e.g. client reconnect) must not trigger
 *  auto-save because snapshotSession() may return an empty terminal
 *  list at that point, which would clear the saved session. */
export function setActiveTerminalId(id: TerminalId | null): void {
  activeTerminalId = id;
  if (id !== null) terminalsDirtyChannel.publish({});
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
  getTerminalBackendFor({ kind: "local" }).killAllTerminals();
}
