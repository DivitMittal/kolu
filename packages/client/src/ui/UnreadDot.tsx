import type { Component } from "solid-js";

/** Pulsing 2×2 alert dot used wherever Kolu marks a terminal that has
 *  caught the user's attention — workspace-switcher pill, expanded
 *  card, canvas tile. The outer span keeps `inline-flex h-2 w-2`;
 *  callers add the positioning class (`absolute -top-1 -right-1`,
 *  inline-flow with `mt-1.5 shrink-0`, etc.).
 *
 *  The minimap dot is intentionally NOT this component — it's smaller
 *  and static (no ping halo) since animation reads as jitter at
 *  minimap scale. Don't unify them. */
export const UnreadDot: Component<{
  class?: string;
  "data-testid"?: string;
}> = (props) => (
  <span
    aria-hidden="true"
    class={`inline-flex h-2 w-2 ${props.class ?? ""}`}
    data-testid={props["data-testid"]}
  >
    <span class="absolute inline-flex h-full w-full rounded-full bg-alert opacity-75 animate-ping" />
    <span class="relative inline-flex rounded-full h-2 w-2 bg-alert" />
  </span>
);
