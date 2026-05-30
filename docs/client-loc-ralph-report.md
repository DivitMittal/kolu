# Slimming Kolu — `solid-*` package extraction (Ralph report)

**Goal:** Reduce `packages/client/src` surface area by extracting app-agnostic
SolidJS code into reusable `@kolu/solid-*` packages under `packages/`, following
the existing `@kolu/solid-pierre` precedent.

**Metric:** Total lines of `*.ts` + `*.tsx` under `packages/client/src`
(tests included — they move with their module). Deterministic, so a single
measurement per cycle suffices (no sampling).

**Measurement command:**
```sh
find packages/client/src \( -name '*.ts' -o -name '*.tsx' \) | xargs wc -l | tail -1
```

**Constraints (from user):**
- Behaviour-preserving only — pure mechanical move + re-export.
- CI green every commit (`just check` + `just test-unit`).
- Run Linux CI locally if the `pu` box fails.

## Baseline

| Metric | Value |
|---|---|
| `client/src` LOC | **25,613** |
| `client/src` files | 189 |
| Existing `solid-*` packages | `@kolu/solid-pierre` |

## Decomposition (volatility axes — Lowy/Hickey)

Boundaries chosen so each package encapsulates one axis of change, not merely
"things that look similar":

| Package | Modules | Volatility axis | ~LOC |
|---|---|---|---|
| `@kolu/solid-icons` | `Icons.tsx` | icon-set content (icons added/removed) | 615 |
| `@kolu/solid-ui` | `Toggle`, `Kbd`, `SegmentedControl`, `Row`, `Section`, `Surface`, `stackLayers`, `Tip` | design-system / presentation | ~285 |
| `@kolu/solid-overlay` | `useAnchoredPopover`(+test), `OptionMenu` | anchored positioning / overlays | ~256 |
| `@kolu/solid-platform` | `keyboard`, `platform`, `clipboard` | browser / platform-API | ~207 |

Order = biggest-contributor-first (Ralph rule).

## Optimization log

| Cycle | Change | client/src LOC | Δ | Commit |
|---|---|---|---|---|
| 0 | baseline | 25,613 | — | — |

## Dead ends

_(none yet)_

## Key findings

_(pending)_
