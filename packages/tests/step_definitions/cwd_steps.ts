/** CWD display assertions for the inspector companion.
 *
 *  After the canvas-peer companion refactor the cwd lives only inside
 *  MetadataInspector, and inspectors are per-anchor. A scenario that
 *  opens the inspector in its Background then creates a new terminal
 *  (worktree creation, command-palette new-terminal) leaves the
 *  inspector welded to the original anchor while the new terminal
 *  becomes active. Tests written for the former global right panel
 *  assume header-CWD-tracks-active semantics.
 *
 *  This step bridges the gap by toggling the inspector keybind to
 *  drive an inspector onto the active tile, retrying once if the
 *  initial state is "active already had an inspector and the toggle
 *  closed it." Phase 1.1 will rewrite these scenarios with
 *  canvas-peer-native assertions. */

import { Then } from "@cucumber/cucumber";
import { type KoluWorld, MOD_KEY, POLL_TIMEOUT } from "../support/world.ts";

async function waitForActiveInspectorCwd(
  world: KoluWorld,
  expected: string,
  timeout: number,
): Promise<boolean> {
  try {
    await world.page.waitForFunction(
      (exp) => {
        const tile = document.querySelector(
          '[data-canvas-tile][data-active="true"]',
        );
        const activeId = tile?.getAttribute("data-terminal-id");
        if (!activeId) return false;
        const companion = document.querySelector(
          `[data-companion-anchor="${activeId}"][data-companion-kind="inspector"]`,
        );
        if (!companion) return false;
        const cwd = companion.querySelector('[data-testid="inspector-cwd"]');
        return (cwd?.textContent ?? "").includes(exp);
      },
      expected,
      { timeout },
    );
    return true;
  } catch {
    return false;
  }
}

Then(
  "the header CWD should show {string}",
  async function (this: KoluWorld, expected: string) {
    // Try one toggle press — opens the inspector on the active tile if
    // it wasn't already open there. Retry once: if the initial active
    // tile already had an inspector, the first press closed it; the
    // second press reopens.
    await this.page.keyboard.press(`${MOD_KEY}+Alt+b`);
    await this.waitForFrame();
    const half = Math.floor(POLL_TIMEOUT / 2);
    if (await waitForActiveInspectorCwd(this, expected, half)) return;
    await this.page.keyboard.press(`${MOD_KEY}+Alt+b`);
    await this.waitForFrame();
    if (await waitForActiveInspectorCwd(this, expected, half)) return;
    throw new Error(
      `Timed out waiting for active tile's inspector-cwd to contain "${expected}"`,
    );
  },
);
