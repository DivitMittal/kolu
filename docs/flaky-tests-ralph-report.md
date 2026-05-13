# Flaky E2E Tests Ralph Report

Date: 2026-05-13
Branch: `ralph-flaky-e2e-2026-05-13`
PR: https://github.com/juspay/kolu/pull/877

## Goal

Improve the reliability of Kolu's Cucumber/Playwright e2e suite on both the
local Linux development machine and the `sincereintent` macOS machine.

Primary metric: repeated `just ci e2e` success rate. A run is green only when
the packaged `just test` e2e step passes through the CI wrapper on the target
platform.

Secondary metric: failure clustering by feature, scenario, step, and platform.
The loop targets the dominant observed failure mode first instead of guessing
from old flakes.

## Methodology

- Linux command: `CI_SYSTEM=x86_64-linux just ci e2e`
- macOS command: `CI_SYSTEM=aarch64-darwin just ci e2e`
- Baseline: paired full-suite runs per platform, extended when a failure class
  needed confirmation.
- Re-measure: the same command and parallelism after each targeted change.
- Commit policy: one targeted change per cycle; commit only changes that remove
  an observed failure class or clearly improve stability beyond noise.

## Baseline (HEAD = `cec13ae`)

| Run | Platform | Result | Failure |
| --- | -------- | ------ | ------- |
| baseline-1 | `x86_64-linux` | 295 / 295 passed | none |
| baseline-1 | `aarch64-darwin` (`sincereintent`) | 294 / 295 passed | `keyboard-shortcuts.feature:39` timed out after `When I press the prev terminal shortcut`; the active terminal never showed `cycle-second` |

The first paired baseline was enough to expose a platform-specific failure:
Linux accepted the positional terminal-cycle chord, while macOS Chrome did not
reliably deliver the same `Cmd+Shift+[` input to the app.

## Optimization Log

| Cycle | Platform | Target | Classification | Change | Re-measure |
| ----- | -------- | ------ | -------------- | ------ | ---------- |
| 1 | macOS primary, Linux regression guard | `nextTerminal` / `prevTerminal` shortcut registration and e2e step | Browser-reserved platform chord: `Cmd+Shift+[` / `Cmd+Shift+]` overlaps macOS Chrome tab navigation, so it is not reliable app input | Move next/previous terminal to physical `Ctrl+Shift+[` / `Ctrl+Shift+]` in the action registry and make the e2e step press that same physical chord | post1: Linux 295/295, macOS 295/295; post2: Linux 295/295, macOS 295/295 |
| 2 | Linux and macOS | OpenCode state polling, reload/session-restore empty-state transitions, SQLite WAL watcher | Three separate race classes surfaced after cycle 1: the OpenCode WAL file can be checkpointed and recreated under a new inode, reload could show empty state while the terminal list was loaded but metadata had not yielded, and restore cleared the saved-session card while Playwright was still clicking it | Keep the WAL directory watcher alive so direct file watches are re-armed on replacement; base app empty-state visibility on the raw terminal list subscription; keep the restore card mounted behind an explicit `isRestoring` state; delete OpenCode mock `part` rows before `message` rows | final code tip: Linux 295/295, macOS 295/295 |

## Final Measurement

Post-fix code HEAD: `7d6bc6a`

| Run | HEAD | Platform | Result | CI status description |
| --- | ---- | -------- | ------ | --------------------- |
| post1 | `2f69016` | `x86_64-linux` | 295 / 295 passed | `86s; .logs/2f69016/e2e@x86_64-linux.log` |
| post1 | `2f69016` | `aarch64-darwin` (`sincereintent`) | 295 / 295 passed | `120s; .logs/2f69016/e2e@aarch64-darwin.log` |
| post2 | `2f69016` | `x86_64-linux` | 295 / 295 passed | `83s; .logs/2f69016/e2e@x86_64-linux.log` |
| post2 | `2f69016` | `aarch64-darwin` (`sincereintent`) | 295 / 295 passed | `118s; .logs/2f69016/e2e@aarch64-darwin.log` |
| final | `7d6bc6a` | `x86_64-linux` | 295 / 295 passed | `86s; .logs/7d6bc6a/e2e@x86_64-linux.log` |
| final | `7d6bc6a` | `aarch64-darwin` (`sincereintent`) | 295 / 295 passed | `122s; .logs/7d6bc6a/e2e@aarch64-darwin.log` |

The original macOS shortcut failure did not recur in either post-cycle-1 paired
run. The later OpenCode, reload, and restore failure classes did not recur in
the paired final run after cycle 2.

## Findings

- `just ci e2e` runs 295 non-`@skip` Cucumber scenarios through the packaged
  `just test` path.
- The first observed failure was not a generic timing problem. It was a shortcut
  ownership problem: app-level terminal cycling used the platform modifier, but
  macOS Chrome already owns `Cmd+Shift+[` / `Cmd+Shift+]` for tab navigation.
- The action registry already distinguishes platform `mod` from physical
  `ctrl`; using that existing type-level distinction keeps the fix local to the
  shortcut declaration and lets the help/palette formatting update
  automatically.
- Empty-state decisions must use the server terminal-list subscription, not the
  metadata-derived terminal id list. Metadata subscriptions are intentionally
  per-terminal and can lag the list on reload.
- SQLite WAL watchers need to treat the WAL path as replaceable, not stable.
  Keeping the directory watcher alive and re-arming the direct file watcher on
  identity change closes the checkpoint/delete/recreate race without adding
  per-session watchers.
- Session restore is a multi-RPC workflow, so it now has explicit in-flight UI
  state. Clearing the saved session before the first RPC completed made the
  click target disappear under load.

## Dead Ends

- Early cycle-1 post-fix runs were green, but the next report-tip verification
  surfaced unrelated failure classes. Those became cycle 2 instead of being
  treated as timing noise.
- No README architecture update was required: the Architecture section already
  describes the OpenCode provider as SQLite WAL-backed and the provider watcher
  model remains accurate.
