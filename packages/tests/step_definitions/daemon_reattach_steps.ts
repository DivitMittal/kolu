/**
 * Step for the R4c local-PTY-daemon reattach test.
 *
 * Restarts kolu-server while the detached `kolu --stdio` PTY-host daemon
 * (and its live PTYs) survives — the precondition for reattach-by-id. The
 * client's WebSocket drops when the old server dies and auto-reconnects to
 * the fresh one; on reboot the server's `reattachLocalTerminals` re-registers
 * the surviving terminals, so the client's retried `attach` streams reconnect
 * to the same shells with scrollback intact.
 */

import { When } from "@cucumber/cucumber";
import { restartKoluServer } from "../support/hooks.ts";
import type { KoluWorld } from "../support/world.ts";

When("I restart the kolu server", async function (this: KoluWorld) {
  await restartKoluServer();
});
