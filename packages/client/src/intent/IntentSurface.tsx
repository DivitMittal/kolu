import { type Component, Show } from "solid-js";
import { copyTextWithToast } from "../clipboard";
import { CopyIcon, PencilIcon } from "../ui/Icons";
import { IntentMarkdownBlock, IntentMarkdownInline } from "./IntentMarkdown";
import { firstIntentLine, hasMultipleIntentLines } from "./text";

/** Terminal-theme colors used to tint an intent surface. */
export type IntentTheme = {
  bg: string;
  fg: string;
};

/** Shared color treatment for intent tabs and blocks. */
export const intentThemeStyle = (theme: IntentTheme | undefined) =>
  theme
    ? {
        color: theme.fg,
        "background-color": `color-mix(in oklch, ${theme.fg} 10%, ${theme.bg})`,
        "border-color": `color-mix(in oklch, ${theme.fg} 28%, ${theme.bg})`,
        "--tw-ring-color": `color-mix(in oklch, ${theme.fg} 45%, ${theme.bg})`,
      }
    : undefined;

/** First-line markdown summary plus a multiline marker. */
export const IntentSummary: Component<{ intent: string }> = (props) => (
  <>
    <IntentMarkdownInline markdown={firstIntentLine(props.intent)} />
    <Show when={hasMultipleIntentLines(props.intent)}>
      <span class="ml-1 opacity-60">↵</span>
    </Show>
  </>
);

/** Attached intent tab for workspace-switcher cards. */
export const IntentAttachedTab: Component<{
  intent: string;
  theme?: IntentTheme;
  testId: string;
}> = (props) => (
  <div
    data-testid={props.testId}
    class="pointer-events-none absolute left-2 top-0 z-10 max-w-[calc(100%-1rem)] truncate rounded-b-md rounded-t-none border-x border-b border-accent/35 bg-surface-1/95 px-2 py-0.5 text-[0.64rem] leading-none text-fg shadow-[0_8px_18px_-14px_rgba(0,0,0,0.9)]"
    style={intentThemeStyle(props.theme)}
    title={props.intent}
  >
    <IntentSummary intent={props.intent} />
  </div>
);

/** Full markdown intent block with copy and edit controls. */
export const IntentBlock: Component<{
  intent: string;
  testId: string;
  copyTestId: string;
  editTestId: string;
  theme?: IntentTheme;
  onEdit: () => void;
}> = (props) => (
  <div
    data-testid={props.testId}
    class="mt-2 rounded-md border border-edge/70 bg-surface-2/35 px-2 py-1.5 text-[0.72rem] leading-snug text-fg"
    style={intentThemeStyle(props.theme)}
    title={props.intent}
  >
    <div class="flex items-start gap-2">
      <IntentMarkdownBlock markdown={props.intent} />
      <IntentActionButtons
        intent={props.intent}
        copyTestId={props.copyTestId}
        editTestId={props.editTestId}
        onEdit={props.onEdit}
      />
    </div>
  </div>
);

/** Copy/edit icon controls for an intent block. */
export const IntentActionButtons: Component<{
  intent: string;
  copyTestId: string;
  editTestId: string;
  onEdit: () => void;
}> = (props) => {
  const stop = (event: Event) => event.stopPropagation();
  return (
    <div class="flex shrink-0 items-center gap-0.5">
      <button
        type="button"
        data-testid={props.copyTestId}
        class="pointer-events-auto flex h-5 w-5 items-center justify-center rounded-md text-current opacity-65 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2"
        title="Copy intent"
        aria-label="Copy intent"
        onPointerDown={stop}
        onKeyDown={stop}
        onDblClick={stop}
        onClick={(event) => {
          event.stopPropagation();
          void copyTextWithToast(props.intent, {
            success: "Copied intent to clipboard",
            failure: "Failed to copy intent",
          });
        }}
      >
        <CopyIcon class="h-3 w-3" />
      </button>
      <button
        type="button"
        data-testid={props.editTestId}
        class="pointer-events-auto flex h-5 w-5 items-center justify-center rounded-md text-current opacity-65 transition-opacity hover:opacity-100 focus-visible:outline-none focus-visible:ring-2"
        title="Edit intent"
        aria-label="Edit intent"
        onPointerDown={stop}
        onKeyDown={stop}
        onDblClick={stop}
        onClick={(event) => {
          event.stopPropagation();
          props.onEdit();
        }}
      >
        <PencilIcon class="h-3 w-3" />
      </button>
    </div>
  );
};
