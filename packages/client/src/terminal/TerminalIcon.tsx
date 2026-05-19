/** Pure renderer for a terminal's user-chosen icon — emoji or any
 *  short string. Owns the unset fallback (`<Show when>`) so each call
 *  site is a one-liner; takes a scalar prop, not `TerminalDisplayInfo`,
 *  so surfaces that consume `TerminalMetadata` directly (like
 *  `SubPanelTabBar`) can use the same component without rewiring.
 *
 *  Per-terminal scope is established by the field declaration in
 *  `surface.ts`; this component does not inject any default. */

import { type Component, Show } from "solid-js";

const TerminalIcon: Component<{
  icon: string | undefined;
  /** Tailwind size + spacing applied to the outer span. Override for
   *  tighter chromes (e.g. sub-panel tabs) where the default `text-base
   *  leading-none` would overflow the row. */
  class?: string;
}> = (props) => (
  <Show when={props.icon}>
    {(icon) => (
      <span
        data-testid="terminal-icon"
        class={props.class ?? "text-base leading-none shrink-0"}
        aria-hidden="true"
      >
        {icon()}
      </span>
    )}
  </Show>
);

export default TerminalIcon;
