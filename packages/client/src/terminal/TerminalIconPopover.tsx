/** Picker for a terminal's user-chosen icon.
 *
 *  Two input paths into one scalar outcome:
 *    1. A curated quick row of emoji glyphs — common terminal personas
 *       (home, experiment, bug, fire, …) that read at a glance.
 *    2. A free-form text input — accepts any character. macOS users can
 *       open the native picker (⌃⌘Space) inside the input.
 *
 *  Plus a Clear action that writes the empty string (server interprets
 *  that as "unset"). Anchored popover scaffold mirrors
 *  `SettingsPopover.tsx`. */

import { type Component, For, Show, createSignal } from "solid-js";
import { Portal } from "solid-js/web";
import { useAnchoredPopover } from "../ui/useAnchoredPopover";

const QUICK_ROW = [
  "🏠",
  "🧪",
  "🐛",
  "⚡",
  "🔥",
  "🚀",
  "🎯",
  "📦",
  "🔧",
  "✨",
  "🧠",
  "🌱",
] as const;

const TerminalIconPopover: Component<{
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef?: HTMLElement;
  currentIcon: string | undefined;
  onSelect: (icon: string) => void;
}> = (props) => {
  const [draft, setDraft] = createSignal("");

  const { panelRef, panelStyle } = useAnchoredPopover({
    triggerRef: () => props.triggerRef,
    open: () => props.open,
    onDismiss: () => props.onOpenChange(false),
    anchor: "bottom-start",
  });

  function commit(icon: string) {
    props.onSelect(icon);
    setDraft("");
    props.onOpenChange(false);
  }

  function submitDraft(e: SubmitEvent) {
    e.preventDefault();
    const next = draft().trim();
    if (next.length === 0) return;
    commit(next);
  }

  return (
    <Show when={props.open}>
      <Portal>
        <div
          ref={panelRef}
          data-testid="terminal-icon-popover"
          class="fixed z-50 bg-surface-1 border border-edge rounded-2xl shadow-2xl shadow-black/50 p-3 min-w-[240px] space-y-3"
          style={{
            ...panelStyle(),
            "background-color": "var(--color-surface-1)",
          }}
        >
          <div class="flex flex-wrap gap-1">
            <For each={QUICK_ROW}>
              {(glyph) => (
                <button
                  type="button"
                  data-testid="terminal-icon-quick"
                  data-glyph={glyph}
                  data-selected={props.currentIcon === glyph ? "" : undefined}
                  class="flex items-center justify-center w-8 h-8 rounded-md text-lg leading-none cursor-pointer hover:bg-surface-2/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                  classList={{
                    "bg-surface-2 ring-1 ring-accent/40":
                      props.currentIcon === glyph,
                  }}
                  onClick={() => commit(glyph)}
                  aria-label={`Set terminal icon to ${glyph}`}
                >
                  {glyph}
                </button>
              )}
            </For>
          </div>
          <form class="flex items-center gap-2" onSubmit={submitDraft}>
            <input
              type="text"
              data-testid="terminal-icon-custom"
              value={draft()}
              onInput={(e) => setDraft(e.currentTarget.value)}
              placeholder="Custom (any emoji)"
              class="flex-1 min-w-0 rounded px-2 py-1 text-sm bg-surface-0 border border-edge focus:outline-none focus:ring-2 focus:ring-accent/40"
              autocomplete="off"
              autocorrect="off"
              spellcheck={false}
            />
            <button
              type="submit"
              class="px-2 py-1 text-xs rounded bg-accent/20 hover:bg-accent/30 cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              disabled={draft().trim().length === 0}
            >
              Set
            </button>
          </form>
          <Show when={props.currentIcon}>
            <button
              type="button"
              data-testid="terminal-icon-clear"
              class="w-full px-2 py-1 text-xs rounded text-fg-2 hover:bg-surface-2/70 cursor-pointer"
              onClick={() => commit("")}
            >
              Clear icon
            </button>
          </Show>
        </div>
      </Portal>
    </Show>
  );
};

export default TerminalIconPopover;
