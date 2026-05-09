/** CWD display assertions for the inspector companion.
 *
 *  After the canvas-peer companion refactor the cwd lives only inside
 *  MetadataInspector. Companions are per-anchor — when a feature
 *  creates a new terminal mid-scenario the inspector stays welded to
 *  the original anchor and continues showing its cwd, not the new
 *  active terminal's. Tests assume global "header CWD" semantics, so
 *  the step closes any open inspector and re-opens it on the active
 *  tile before asserting. This bridges the per-anchor design with the
 *  legacy "header" wording until Phase 1.1 redesigns the cwd
 *  assertions natively. */

import { Then } from "@cucumber/cucumber";
import { type KoluWorld, MOD_KEY, POLL_TIMEOUT } from "../support/world.ts";

Then(
  "the header CWD should show {string}",
  async function (this: KoluWorld, expected: string) {
    // Re-open the inspector companion on the currently active tile.
    // Twice because toggle: first press closes whatever was open
    // (possibly on a stale anchor), second press opens on the active
    // tile. The fallback in App.tsx routes to terminalIds[0] when
    // activeId is null, so the second press always lands on something.
    await this.page.keyboard.press(`${MOD_KEY}+Alt+b`);
    await this.waitForFrame();
    await this.page.keyboard.press(`${MOD_KEY}+Alt+b`);
    await this.waitForFrame();
    await this.page.waitForFunction(
      (exp) => {
        const el = document.querySelector('[data-testid="inspector-cwd"]');
        return (el?.textContent ?? "").includes(exp);
      },
      expected,
      { timeout: POLL_TIMEOUT },
    );
  },
);
