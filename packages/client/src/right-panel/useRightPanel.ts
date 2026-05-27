/** Right panel state — singleton module.
 *
 *  Three storage layers because the right panel has three volatilities:
 *
 *  - **Workspace chrome** (collapsed, size, codeTabTreeSize) lives on
 *    `preferences.rightPanel` — global to the user, set once and forgotten.
 *    Drives the desktop Resizable's collapsed/expanded geometry.
 *  - **Mobile drawer open state** is session-local, NOT persisted. Dismissing
 *    the bottom-drawer host on a phone is an ephemeral gesture; persisting
 *    it into account prefs would mean the next desktop session opens with
 *    the panel collapsed for reasons the user never expressed on desktop.
 *  - **Per-terminal task state** (activeTab, codeMode, per-mode selected
 *    file) lives in an in-memory store keyed by terminal id; mutations
 *    push to the server via `client.terminal.setRightPanel`, which writes
 *    `TerminalMetadata.rightPanel` for session restore. Pattern mirrors
 *    `useSubPanel.ts` exactly.
 *
 *  Callers read/write for the *active* terminal — the API is parameterless,
 *  resolving the current terminal id from `useTerminalStore` internally. */

import {
  type CodeTabView,
  DEFAULT_RIGHT_PANEL_PER_TERMINAL,
  type RightPanelPerTerminalState,
  type RightPanelTab,
  type TerminalId,
  rightPanelView,
} from "kolu-common/surface";
import { createSignal } from "solid-js";
import { createStore, produce } from "solid-js/store";
import { useTerminalStore } from "../terminal/useTerminalStore";
import { client, preferences, updatePreferences } from "../wire";

/** Bounds for the desktop right panel width as a fraction of the layout
 *  container. Floor keeps the panel usable without forcing the user to
 *  collapse to hide it; ceiling mirrors the prior Resizable's
 *  `minSize={0.3}` on the canvas side. Enforced inside `setPanelSize`
 *  so every writer — drag gesture, future keyboard resize, session
 *  restore — funnels through one clamp. */
const MIN_PANEL_FRACTION = 0.2;
const MAX_PANEL_FRACTION = 0.7;
/** Lower bound for the Code-tab vertical split — keep the tree and content
 *  panes from collapsing to invisible via drag. */
const MIN_TREE_SIZE = 0.1;
const MAX_TREE_SIZE = 0.9;

const [perTerminal, setPerTerminal] = createStore<
  Record<TerminalId, RightPanelPerTerminalState>
>({});

/** Session-local visibility of the mobile bottom-drawer host. Distinct from
 *  the persisted `preferences.rightPanel.collapsed` bit so dismissing the
 *  drawer on mobile doesn't cross-contaminate the desktop chrome preference.
 *  `RightPanelLayout`'s mobile branch owns the open/close gestures; the
 *  desktop branch ignores this signal entirely. */
const [drawerOpen, setDrawerOpen] = createSignal(false);

function ensureState(id: TerminalId): void {
  if (perTerminal[id]) return;
  setPerTerminal(id, { ...DEFAULT_RIGHT_PANEL_PER_TERMINAL });
}

function reportToServer(id: TerminalId): void {
  const s = perTerminal[id];
  if (!s) return;
  void client.terminal
    .setRightPanel({
      id,
      activeTab: s.activeTab,
      codeMode: s.codeMode,
      selectedFileByMode: s.selectedFileByMode,
    })
    .catch((err: Error) =>
      console.error("useRightPanel: setRightPanel RPC failed", err),
    );
}

export function useRightPanel() {
  const store = useTerminalStore();
  const rp = () => preferences().rightPanel;

  /** Read the per-terminal record for the active terminal, falling back
   *  to defaults when no terminal is active or the terminal has no record
   *  yet. The returned object is read-only — write through the mutators. */
  function activeState(): RightPanelPerTerminalState {
    const id = store.activeId();
    if (id === null) return DEFAULT_RIGHT_PANEL_PER_TERMINAL;
    return perTerminal[id] ?? DEFAULT_RIGHT_PANEL_PER_TERMINAL;
  }

  /** Mutate the active terminal's per-terminal record. No-op when no
   *  terminal is active — clicks on the panel before a terminal exists
   *  are dropped silently.
   *
   *  Accepts either a shallow patch (`Partial<RightPanelPerTerminalState>`)
   *  or a producer function for nested updates (e.g. mutating one key in
   *  `selectedFileByMode`). Both paths share the same `ensureState →
   *  setStore → reportToServer` triplet so future contract changes
   *  (client-side equality gate, telemetry) land in one place. */
  function mutateActive(
    update:
      | Partial<RightPanelPerTerminalState>
      | ((s: RightPanelPerTerminalState) => void),
  ): void {
    const id = store.activeId();
    if (id === null) return;
    ensureState(id);
    if (typeof update === "function") {
      setPerTerminal(id, produce(update));
    } else {
      setPerTerminal(id, update);
    }
    reportToServer(id);
  }

  return {
    // ── Workspace chrome (global) ────────────────────────────────────
    collapsed: () => rp().collapsed,
    panelSize: () => rp().size,
    togglePanel: () =>
      updatePreferences({ rightPanel: { collapsed: !rp().collapsed } }),
    collapsePanel: () => updatePreferences({ rightPanel: { collapsed: true } }),
    expandPanel: () => updatePreferences({ rightPanel: { collapsed: false } }),
    setPanelSize: (size: number) => {
      const clamped = Math.min(
        MAX_PANEL_FRACTION,
        Math.max(MIN_PANEL_FRACTION, size),
      );
      updatePreferences({ rightPanel: { size: clamped } });
    },
    /** Vertical split fraction inside the Code tab — tree pane occupies
     *  this share, content pane gets the rest. Persisted across reload. */
    codeTabTreeSize: () => rp().codeTabTreeSize,
    setCodeTabTreeSize: (size: number) => {
      if (size >= MIN_TREE_SIZE && size <= MAX_TREE_SIZE) {
        updatePreferences({ rightPanel: { codeTabTreeSize: size } });
      }
    },

    // ── Mobile drawer (session-local) ────────────────────────────────
    /** Whether the mobile bottom-drawer host is open. Only meaningful on
     *  mobile — desktop reads `collapsed()` instead. Not persisted. */
    drawerOpen,
    setDrawerOpen,

    // ── Per-terminal task state ──────────────────────────────────────
    /** DU view of the active tab — `{ kind: "inspector" }` or
     *  `{ kind: "code", mode }`. Matches `match(...).with(...).exhaustive()`. */
    activeTab: (): RightPanelTab => rightPanelView(activeState()),
    /** Persisted Code-tab sub-mode regardless of which tab is active.
     *  CodeTab needs the mode even when the user has flipped over to
     *  Inspector — selection / filter state is keyed by it, and the
     *  fallback behaviour of reading `activeTab` would mask a "browse"
     *  selection as "local" while Inspector is active and trigger a
     *  spurious reset on the round-trip back. */
    codeMode: (): CodeTabView => activeState().codeMode,
    /** Switch to Inspector. `codeMode` is preserved so toggling back to Code
     *  restores the user's last sub-mode. */
    showInspector: () => mutateActive({ activeTab: "inspector" }),
    /** Switch to Code tab. When `mode` is omitted, the persisted `codeMode`
     *  is used — this is the round-trip case (Inspector→Code restores the
     *  last view). Pass `mode` explicitly to override. */
    showCode: (mode?: CodeTabView) =>
      mutateActive({
        activeTab: "code",
        ...(mode !== undefined && { codeMode: mode }),
      }),
    /** Atomic "set the Code tab at `mode`" — switch to Code, set the
     *  requested sub-mode. Does NOT touch visibility (collapsed pref or
     *  drawer-open signal); the host (`RightPanelLayout`) watches the
     *  paired `pendingOpen` signal seeded by `openInCodeTab` and ensures
     *  the surface is visible per its own semantics (desktop expand vs.
     *  mobile drawer open). Keeping visibility out of this function is
     *  what lets one persisted bit live on the desktop side without
     *  mobile gestures polluting it.
     *
     *  Short-circuits when the tab+mode is already current — every
     *  diff→browse and browse→browse `openCodeAt` would otherwise
     *  round-trip an idempotent write to the server. */
    openCodeAt: (mode: CodeTabView) => {
      const cur = activeState();
      if (cur.activeTab === "code" && cur.codeMode === mode) return;
      mutateActive({ activeTab: "code", codeMode: mode });
    },
    /** Change the sub-mode within the Code tab. */
    setCodeMode: (mode: CodeTabView) => mutateActive({ codeMode: mode }),

    /** Per-mode file selection — repo-relative path, or null when no file
     *  is selected in this mode. Keyed by `(activeTerminal, mode)` so each
     *  terminal remembers its own pick in each of local/branch/browse. */
    selectedFile: (mode: CodeTabView): string | null =>
      activeState().selectedFileByMode?.[mode] ?? null,
    setSelectedFile: (mode: CodeTabView, path: string | null) => {
      mutateActive((s) => {
        const cur = s.selectedFileByMode ?? {};
        if (path === null) {
          if (!(mode in cur)) return;
          const { [mode]: _, ...rest } = cur;
          s.selectedFileByMode =
            Object.keys(rest).length > 0 ? rest : undefined;
        } else {
          if (cur[mode] === path) return;
          s.selectedFileByMode = { ...cur, [mode]: path };
        }
      });
    },

    // ── Session restore + lifecycle ──────────────────────────────────
    /** Seed per-terminal state from server data — no report-back to
     *  server. Called by `useSessionRestore` during hydration and after
     *  recreating a saved terminal. */
    seedPanel: (id: TerminalId, state: RightPanelPerTerminalState) => {
      setPerTerminal(id, state);
    },
    /** Clean up state for a terminal that no longer exists. Mirrors
     *  `useSubPanel.removePanel`. */
    removePanel: (id: TerminalId) => {
      setPerTerminal(produce((s) => delete s[id]));
    },
  } as const;
}
