import { spawn } from "node:child_process";
import fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  decayTransientState,
  deriveState,
  hasNoDescendants,
  snapshotProcessTree,
  TRANSIENT_STALE_MS,
} from "./core.ts";

// --- The phantom transient pill (#1017) ---
//
// A trailing transient state keeps `deriveState` reporting a *working* state
// with no decay once the session is abandoned (most reliably: claude killed
// mid-turn, then resumed idle by session-restore). The dock spins forever. Two
// trailing shapes hit it, each disambiguated by its own out-of-band signal once
// the transcript has gone quiet past a window:
//   - dangling `tool_use`: a live tool keeps a descendant process; an abandoned
//     one has none — so "subtree idle (no descendant)" tells them apart.
//   - `thinking` (trailing `user` prompt): childless and quiet whether live or
//     abandoned, so the discriminator is the prompt's age — an ORPHANED prompt
//     (predating this resumed claude's `startedAt`) belongs to a killed instance
//     the current claude never processed. A live turn's prompt postdates
//     `startedAt`, so it is never cleared.
// `decayTransientState` is the pure policy that composes these.

describe("decayTransientState (#1017 phantom transient pill)", () => {
  const idle = () => true;
  const busy = () => false;
  // A fixed clock sample so the absolute `recheckAt` deadline is assertable
  // (the caller passes the same `now` it used to measure the quiet window).
  const now = 1_700_000_000_000;
  /** A probe that fails the test if invoked — asserts the window gate runs
   *  before the (real, process-spawning) subtree probe so the common path
   *  never pays for it. */
  const neverProbed = () => {
    throw new Error(
      "subtree probe must not run before the quiet window elapses",
    );
  };
  /** Probe bundle: `tool_use` reads `subtreeIdle`; `thinking` also reads
   *  `promptOrphaned`. Default `promptOrphaned: false` (the safe live-turn
   *  case); tests that exercise the orphaned path set it true. */
  const probes = (
    subtreeIdle: () => boolean,
    promptOrphaned = false,
  ): { subtreeIdle: () => boolean; promptOrphaned: boolean } => ({
    subtreeIdle,
    promptOrphaned,
  });

  it("settles a dangling `tool_use` pill to `waiting` once stale and the subtree is idle", () => {
    // The reproduced case: claude killed mid-Bash, resumed idle — a dangling
    // tool_use with no tool_result and no live child process.
    expect(
      decayTransientState(
        "tool_use",
        TRANSIENT_STALE_MS + 1_000,
        probes(idle),
        undefined,
        now,
      ),
    ).toEqual({ state: "waiting", recheckAt: null });
  });

  it("keeps a dangling `tool_use` and schedules a recheck before the window elapses", () => {
    // Not yet stale: never probe the subtree, but arm a one-shot recheck at the
    // absolute moment the window *would* elapse — `now + (staleMs - quietMs)`.
    expect(
      decayTransientState(
        "tool_use",
        TRANSIENT_STALE_MS - 30_000,
        probes(neverProbed),
        undefined,
        now,
      ),
    ).toEqual({ state: "tool_use", recheckAt: now + 30_000 });
  });

  it("keeps a genuinely-working tool_use when the subtree is busy", () => {
    // Stale transcript but claude still has a descendant (a long Bash / a
    // sub-agent) → real work; never cleared. Re-probe a full window from now.
    expect(
      decayTransientState(
        "tool_use",
        TRANSIENT_STALE_MS,
        probes(busy),
        undefined,
        now,
      ),
    ).toEqual({ state: "tool_use", recheckAt: now + TRANSIENT_STALE_MS });
  });

  it("settles an ORPHANED `thinking` pill to `waiting` past the window WITHOUT probing the subtree", () => {
    // The reproduced case: a trailing `user` prompt from a killed instance, the
    // current claude resumed idle (prompt predates startedAt → promptOrphaned).
    // `orphaned + stale` is definitive, so the subtree is never consulted
    // (`neverProbed`) — that's what makes the decay immune to a long-lived MCP/
    // helper child. (On zest, the `append` session held a `chrome-devtools-mcp`
    // child; requiring an idle subtree wrongly kept its phantom spinning.)
    expect(
      decayTransientState(
        "thinking",
        TRANSIENT_STALE_MS + 1_000,
        probes(neverProbed, true),
        undefined,
        now,
      ),
    ).toEqual({ state: "waiting", recheckAt: null });
  });

  it("keeps a LIVE `thinking` turn (prompt not orphaned) — never probes, never decays", () => {
    // A live turn's prompt postdates startedAt → not orphaned. Even long past
    // the window, it is left alone and the subtree probe is never spawned.
    expect(
      decayTransientState(
        "thinking",
        TRANSIENT_STALE_MS * 10,
        probes(neverProbed, false),
        undefined,
        now,
      ),
    ).toEqual({ state: "thinking", recheckAt: null });
  });

  it("keeps an orphaned `thinking` and schedules a recheck before the window elapses", () => {
    expect(
      decayTransientState(
        "thinking",
        TRANSIENT_STALE_MS - 30_000,
        probes(neverProbed, true),
        undefined,
        now,
      ),
    ).toEqual({ state: "thinking", recheckAt: now + 30_000 });
  });

  it.each([
    "waiting",
    "awaiting_user",
    "running_background",
  ] as const)("never decays the non-transient state `%s`", (state) => {
    // running_background has its own decay path (#1109); waiting/awaiting_user
    // are settled / a genuine human gate. None should ever probe the subtree.
    expect(
      decayTransientState(
        state,
        TRANSIENT_STALE_MS * 10,
        probes(neverProbed, true),
        undefined,
        now,
      ),
    ).toEqual({ state, recheckAt: null });
  });
});

describe("deriveState timestampMs (the entry the state derives from)", () => {
  const entry = (type: string, ts?: string, extra: object = {}) =>
    JSON.stringify({ type, ...(ts ? { timestamp: ts } : {}), ...extra });

  it("is the epoch-ms timestamp of the newest user/assistant entry", () => {
    const lines = [
      entry("assistant", "2026-06-02T11:33:48.779Z"),
      entry("user", "2026-06-02T11:35:49.791Z"),
      entry("permission-mode"), // metadata after the prompt — skipped
      entry("ai-title"),
    ];
    expect(deriveState(lines)?.timestampMs).toBe(
      Date.parse("2026-06-02T11:35:49.791Z"),
    );
  });

  it("deriveState returns null when no user/assistant entry exists", () => {
    expect(deriveState([entry("permission-mode"), entry("mode")])).toBeNull();
  });

  it("is null when the newest entry lacks a parseable timestamp", () => {
    expect(deriveState([entry("user")])?.timestampMs).toBeNull();
  });
});

// --- Process-subtree discriminator ---
//
// The signal that separates a live tool from an abandoned one: a working claude
// keeps a descendant process (the Bash child it spawned, or a sub-agent
// claude); an abandoned / killed-then-resumed-idle claude has none.

describe("hasNoDescendants", () => {
  it("is true when no process lists pid as its parent", () => {
    expect(
      hasNoDescendants(100, [
        { pid: 1, ppid: 0 },
        { pid: 100, ppid: 1 },
        { pid: 200, ppid: 1 },
      ]),
    ).toBe(true);
  });

  it("is false when a process is a direct child of pid", () => {
    expect(
      hasNoDescendants(100, [
        { pid: 100, ppid: 1 },
        { pid: 200, ppid: 100 },
      ]),
    ).toBe(false);
  });

  it("is true for a pid absent from the table (process already gone)", () => {
    expect(hasNoDescendants(999, [{ pid: 1, ppid: 0 }])).toBe(true);
  });
});

// --- The pinned `ps` binary (#1121) ---
//
// `snapshotProcessTree` resolves `ps` from `KOLU_PS_BIN` (pinned by Nix —
// `nix/env.nix`), never the ambient PATH, so the phantom-pill decay can't
// silently stop firing in an environment whose PATH lacks `ps`. These tests pin
// the path explicitly so they assert the real probe regardless of the harness's
// PATH, and prove the env var — not PATH — is what's consulted.

describe("snapshotProcessTree", () => {
  const children: ReturnType<typeof spawn>[] = [];
  // A real system `ps` to pin for the positive cases. The dev shell already
  // exports `KOLU_PS_BIN` (the nix procps/BSD path); fall back to the standard
  // system locations so the test stands alone outside `nix develop`.
  const realPs = [process.env.KOLU_PS_BIN, "/bin/ps", "/usr/bin/ps"].find(
    (p): p is string => !!p && fs.existsSync(p),
  );
  let savedPsBin: string | undefined;
  beforeEach(() => {
    savedPsBin = process.env.KOLU_PS_BIN;
  });
  afterEach(() => {
    for (const c of children.splice(0)) c.kill("SIGKILL");
    if (savedPsBin === undefined) delete process.env.KOLU_PS_BIN;
    else process.env.KOLU_PS_BIN = savedPsBin;
  });

  it("samples the live process table including this process (the build/runtime probe)", () => {
    if (!realPs) return; // no system ps on this host — nothing to pin
    process.env.KOLU_PS_BIN = realPs;
    const procs = snapshotProcessTree();
    expect(procs).not.toBeNull();
    expect(procs?.length).toBeGreaterThan(0);
    expect(procs?.some((p) => p.pid === process.pid)).toBe(true);
  });

  it("detects a spawned child as a descendant (the genuine-work signal)", async () => {
    if (!realPs) return;
    process.env.KOLU_PS_BIN = realPs;
    const child = spawn("sleep", ["30"]);
    children.push(child);
    await new Promise((r) => setTimeout(r, 150));
    const procs = snapshotProcessTree();
    expect(procs).not.toBeNull();
    expect(
      procs?.some((p) => p.pid === child.pid && p.ppid === process.pid),
    ).toBe(true);
    expect(hasNoDescendants(process.pid, procs ?? [])).toBe(false);
  });

  it("fails open to null when KOLU_PS_BIN is unset (never de-escalates a working pill)", () => {
    // An unpinned probe must read as "can't tell" — null — so the decay never
    // fires on a misbuilt server rather than silently clearing a genuine pill.
    delete process.env.KOLU_PS_BIN;
    expect(snapshotProcessTree()).toBeNull();
  });

  it("resolves the pinned path, not PATH — a bogus KOLU_PS_BIN yields null even with ps on PATH", () => {
    // The #1121 hardening: the probe consults the pinned binary, so a bad pin
    // can't fall through to an ambient `ps`. If it still found a table here, it
    // would mean PATH resolution leaked back in.
    process.env.KOLU_PS_BIN = "/nonexistent/definitely/not/ps";
    expect(snapshotProcessTree()).toBeNull();
  });
});
