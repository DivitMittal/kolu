import { type Component, Show } from "solid-js";

type HostChipSize = "sm" | "xs";

const sizeClasses: Record<HostChipSize, string> = {
  sm: "text-[10px] px-1.5",
  xs: "text-[0.55rem] px-1",
};

/** Compact SSH host badge shared by tile chrome, dock rows, restore cards,
 *  and the metadata inspector. Local terminals render no badge. */
const HostChip: Component<{
  hostId?: string;
  size?: HostChipSize;
  testId?: string;
  class?: string;
}> = (props) => (
  <Show when={props.hostId}>
    {(hostId) => (
      <span
        data-testid={props.testId}
        class={`inline-flex font-mono leading-none py-0.5 rounded border border-accent/30 text-accent bg-accent/10 shrink-0 ${sizeClasses[props.size ?? "sm"]} ${props.class ?? ""}`}
        title={`SSH host ${hostId()}`}
      >
        SSH {hostId()}
      </span>
    )}
  </Show>
);

export default HostChip;
