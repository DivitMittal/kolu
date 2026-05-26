/** HostChip — small "remote host" indicator for SSH-located terminals.
 *
 *  Phase 1 of kolu#951. Renders nothing for local terminals (the common
 *  case stays visually clean). For SSH terminals, renders a compact pill
 *  with the host alias so the user can tell at a glance which machine
 *  the shell lives on. Consumed by `TerminalMeta`, the workspace
 *  switcher card, the dock card, and the restore card. */

import type { Component } from "solid-js";
import { Show } from "solid-js";
import type { TerminalLocation } from "kolu-common/surface";

export const HostChip: Component<{ location: TerminalLocation }> = (props) => {
  return (
    <Show when={props.location.kind === "ssh" ? props.location : null}>
      {(ssh) => (
        <span
          class="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] uppercase tracking-wider bg-accent/15 text-accent border border-accent/30"
          title={`Remote terminal on ${ssh().host}`}
        >
          <span class="i-lucide-network text-[11px]" aria-hidden="true" />
          {ssh().host}
        </span>
      )}
    </Show>
  );
};
