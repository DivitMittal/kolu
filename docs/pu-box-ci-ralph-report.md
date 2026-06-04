# pu-box CI ralph report

Measurement-driven reduction of the **`x86_64-linux` CI lane wall-clock** — the
pipeline that `/do` runs on an ephemeral `pu` box (`kolu-pr-<N>`, a clean 32-core
NixOS Incus container) per PR. Tracks [juspay/kolu#1173](https://github.com/juspay/kolu/issues/1173).

Prior ralph efforts tuned the **darwin** lane (e2e parallelism, `docs/ci-e2e-macos-ralph-report.md`),
the **nix build derivation** (`docs/nix-build-ralph-report.md`), and the **CI DAG
critical path** (`docs/ci-workflow-ralph-report.md`). This one targets the part
none of them did: the **cold-start tax a fresh `pu` box pays** on every run.

---

## Methodology

- **Metric:** wall-clock of the full linux lane, measured as `max(Exited) − min(Started)`
  over all `@x86_64-linux` process-compose events in `.ci/pc.log` (same extraction
  the #1173 analysis used). Per-recipe durations from the same log.
- **Invocation:** `nix run github:juspay/justci -- run --no-post --platform x86_64-linux --host x86_64-linux=<box> --progress json`,
  run from a fresh local clone per measurement so concurrent `.ci/` dirs never
  collide. `--no-post` keeps strict mode (clean-tree refuse + HEAD worktree pin)
  but skips GitHub status posts.
- **Box:** Intel i9-14900K, 32 cores, 125 GB RAM (typical `pu` placement).
- **n ≥ 5 per condition; report median.** Each run is its own fresh box (`pu create`)
  or fork (`pu fork`), matching real `/do` provisioning.
- **Harness:** `/tmp/ci-bench/{bench.sh,parse-pclog.sh}` (not committed).

---

## Baseline — cold `pu create` (what `/do` does today)

Long pole is **`ci::nix`** (cold Nix store: realises/downloads the full
devour-flake closure the warm dev machine already has). `ci::e2e` runs *under* it,
so on a cold box e2e is **not** the critical path — `ci::nix` is.

| condition | wall (median) | n |
|---|---|---|
| cold `pu create` | _(filling)_ | 5 |

Representative cold run (n=1, `kolu-ci-bench-0`):

| recipe | dur |
|---|---|
| `ci::nix` | 189.0s |
| `ci::e2e` | 125.1s |
| `ci::home-manager` | 112.9s |
| `ci::smoke` | 87.7s |
| `ci::install` | 69.3s |
| `ci::pnpm-hash-fresh` | 67.4s |
| `ci::docs-moc` | 57.6s |
| `ci::unit` | 23.8s |
| `_ci-setup` | 16.1s |
| `ci::surface-example-build` | 15.6s |
| `ci::biome` | 14.9s |
| `ci::fmt` | 14.4s |
| **LANE_WALL** | **215.7s** |

---

## Optimization log

| # | change | lever | wall before → after | commit? |
|---|---|---|---|---|
| _(pending)_ | | | | |

---

## Dead ends

_(to be filled — "X investigated, no improvement")_

---

## Key findings

_(to be filled)_
