import type { QueuedWorktree, TerminalId } from "kolu-common/surface";
import type { Accessor } from "solid-js";
import { createSignal } from "solid-js";

/** Complete behavior for one open intent-editor session. */
export type IntentEditorSession = {
  title: string;
  initialValue: string;
  allowClear: boolean;
  save: (intent: string) => void;
  clear?: () => void;
};

/** Dependencies that hide persistence differences between intent owners. */
export type IntentEditorDeps = {
  queuedWorktrees: Accessor<QueuedWorktree[]>;
  getTerminalIntent: (id: TerminalId) => string | undefined;
  setTerminalIntent: (id: TerminalId, intent?: string) => void;
  enqueueQueuedWorktree: (repoPath: string, intent: string) => void;
  updateQueuedWorktreeIntent: (id: string, intent: string) => void;
  onClose?: () => void;
};

/** Controller for the shared terminal/queued-worktree intent editor. */
export function useIntentEditor(deps: IntentEditorDeps) {
  const [session, setSession] = createSignal<IntentEditorSession | null>(null);

  const close = () => {
    setSession(null);
    deps.onClose?.();
  };

  const openTerminal = (id: TerminalId) => {
    const initialValue = deps.getTerminalIntent(id) ?? "";
    setSession({
      title: "Terminal intent",
      initialValue,
      allowClear: initialValue.trim().length > 0,
      save: (intent) => deps.setTerminalIntent(id, intent),
      clear: () => deps.setTerminalIntent(id, undefined),
    });
  };

  const openQueued = (id: string) => {
    const initialValue =
      deps.queuedWorktrees().find((item) => item.id === id)?.intent ?? "";
    setSession({
      title: "Queued worktree intent",
      initialValue,
      allowClear: false,
      save: (intent) => deps.updateQueuedWorktreeIntent(id, intent),
    });
  };

  const openNewQueued = (repoPath: string, repoName: string) =>
    setSession({
      title: `Queue ${repoName}`,
      initialValue: "",
      allowClear: false,
      save: (intent) => deps.enqueueQueuedWorktree(repoPath, intent),
    });

  const openActiveTerminal = (activeId: TerminalId | null) => {
    if (activeId) openTerminal(activeId);
  };

  return {
    open: () => session() !== null,
    value: () => session()?.initialValue ?? "",
    title: () => session()?.title ?? "Intent",
    allowClear: () => session()?.allowClear ?? false,
    onOpenChange: (open: boolean) => {
      if (!open) close();
    },
    save: (intent: string) => {
      session()?.save(intent);
    },
    clear: () => session()?.clear?.(),
    openActiveTerminal,
    openTerminal,
    openQueued,
    openNewQueued,
  };
}
