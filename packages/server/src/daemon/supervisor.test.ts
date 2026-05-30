import { describe, expect, it } from "vitest";
import { waitForPidGone } from "./supervisor.ts";

describe("waitForPidGone", () => {
  it("resolves quickly when the pid is already gone (ESRCH)", async () => {
    // PID 2^31 - 1 is effectively never a live process; kill(pid, 0) → ESRCH.
    const deadPid = 0x7fffffff;
    const start = Date.now();
    await waitForPidGone(deadPid, 5_000);
    // Should return well before the generous deadline.
    expect(Date.now() - start).toBeLessThan(1_000);
  });

  it("waits until the deadline when the pid is still alive", async () => {
    // Our own process is definitely alive; with a tiny timeout it should poll
    // and then resolve at the deadline (caller proceeds; respawn fails loudly).
    const start = Date.now();
    await waitForPidGone(process.pid, 50);
    expect(Date.now() - start).toBeGreaterThanOrEqual(45);
  });
});
