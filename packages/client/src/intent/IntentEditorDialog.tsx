import Dialog from "@corvu/dialog";
import { type Component, createEffect, createSignal, on, Show } from "solid-js";
import { toast } from "solid-sonner";
import { copyTextWithToast } from "../clipboard";
import { CloseIcon, CopyIcon } from "../ui/Icons";
import ModalDialog from "../ui/ModalDialog";
import { IntentMarkdownBlock } from "./IntentMarkdown";

/** Modal editor for terminal and queued-worktree intent text. */
const IntentEditorDialog: Component<{
  open: boolean;
  title: string;
  value: string;
  allowClear?: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (intent: string) => void;
  onClear?: () => void;
}> = (props) => {
  let textareaRef: HTMLTextAreaElement | undefined;
  const [draft, setDraft] = createSignal("");
  const trimmed = () => draft().trim();
  const canSave = () => trimmed().length > 0;

  createEffect(
    on(
      () => props.open,
      (open) => {
        if (!open) return;
        setDraft(props.value);
        queueMicrotask(() => {
          textareaRef?.focus();
          textareaRef?.select();
        });
      },
    ),
  );

  const save = () => {
    const next = trimmed();
    if (!next) {
      toast.error("Intent is required");
      return;
    }
    props.onSave(next);
    props.onOpenChange(false);
  };

  const clear = () => {
    props.onClear?.();
    props.onOpenChange(false);
  };

  const copy = () => {
    const value = trimmed();
    if (!value) return;
    void copyTextWithToast(value, {
      success: "Copied intent to clipboard",
      failure: "Failed to copy intent",
    });
  };

  return (
    <ModalDialog open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Content class="bg-surface-1 border border-edge rounded-xl shadow-2xl shadow-black/50 p-4 text-sm">
        <div class="mb-3">
          <Dialog.Label class="block text-sm font-semibold text-fg">
            {props.title}
          </Dialog.Label>
        </div>
        <textarea
          ref={textareaRef}
          data-testid="intent-editor-textarea"
          value={draft()}
          onInput={(e) => setDraft(e.currentTarget.value)}
          class="w-full min-h-32 resize-y rounded-md border border-edge bg-surface-0 px-3 py-2 font-mono text-[0.78rem] leading-relaxed text-fg outline-none placeholder:text-fg-3/60 focus:border-accent/70 focus:ring-2 focus:ring-accent/25"
          placeholder="Intent"
          spellcheck={false}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
        />
        <div class="mt-2 min-h-14 max-h-32 overflow-y-auto rounded-md border border-edge/70 bg-surface-0/60 px-3 py-2 text-[0.72rem] leading-snug text-fg-2">
          <IntentMarkdownBlock markdown={draft()} />
        </div>
        <div class="mt-3 flex items-center justify-between gap-2">
          <div class="flex items-center gap-2">
            <button
              type="button"
              data-testid="intent-editor-copy"
              class="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1.5 text-xs text-fg-2 hover:text-fg hover:bg-surface-2 disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={!trimmed()}
              onClick={copy}
            >
              <CopyIcon class="h-3 w-3" />
              <span>Copy</span>
            </button>
            <Show when={props.allowClear}>
              <button
                type="button"
                data-testid="intent-editor-clear"
                class="inline-flex items-center gap-1.5 rounded-md border border-edge px-2.5 py-1.5 text-xs text-fg-3 hover:text-danger hover:bg-surface-2"
                onClick={clear}
              >
                <CloseIcon class="h-3 w-3" />
                <span>Clear</span>
              </button>
            </Show>
          </div>
          <div class="flex items-center gap-2">
            <button
              type="button"
              class="rounded-md px-3 py-1.5 text-xs text-fg-3 hover:text-fg hover:bg-surface-2"
              onClick={() => props.onOpenChange(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              data-testid="intent-editor-save"
              class="rounded-md bg-accent px-3 py-1.5 text-xs font-semibold text-surface-1 disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={!canSave()}
              onClick={save}
            >
              Save
            </button>
          </div>
        </div>
      </Dialog.Content>
    </ModalDialog>
  );
};

export default IntentEditorDialog;
