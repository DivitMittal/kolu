# Inventing electricity: isolating xterm.js into `@kolu/solid-xterm`

> Ralph loop report. Goal: isolate the low-level xterm.js mechanics out of the
> Kolu client into a dedicated `packages/solid-xterm` package, leaving the Kolu
> code itself slimmer and decoupled from xterm internals.

## The electricity analogy

Per Rich Hickey ([*Simple Made Easy*](https://www.informit.com/articles/article.aspx?p=2995357&seqNum=2)):
before electricity was a *utility*, every appliance was wired directly into its
own power source — the wiring and the appliance were **complected**. Electricity
as a standardized service (a plug, a socket, a contract) let appliances stop
caring how power is generated.

Today, Kolu's terminal code is "pre-electricity": `Terminal.tsx` (and seven
other client files) wire xterm.js construction, addon loading, WebGL
context-leak management, private-buffer probes, and iOS touch quirks **directly
into** Kolu domain logic (RPC streaming, themes, sub-panels, file-ref clicks).
The xterm mechanics and the Kolu domain change for different reasons (Lowy's
volatility axis) yet share one tangled file.

`@kolu/solid-xterm` is the electricity: the single package that owns every
`@xterm/*` import. The browser UI and the headless pty-host both "plug in"
instead of each running their own wiring.

## Metric

- **Primary:** LOC in `packages/client/src/terminal/` (the Kolu terminal code we
  want slimmer).
- **Secondary (decoupling signal):** number of `@xterm/*` import sites — and
  files containing them — across `packages/client/src`. Target: → 0 (only
  `solid-xterm` touches xterm).
- **Tertiary:** total `@xterm/*`-importing packages repo-wide. Target: 1.

Constraint: **behavior preserved** — terminal must render/behave identically
(WebGL, fit, search, links, clipboard, scrollback, diagnostics, touch). Verified
each cycle by `pnpm -r typecheck`; e2e (`just test`) + CI at wrap-up.

## Baseline (2026-05-30)

Measured on branch `xterm-ralph` off `master`.

| Metric | Baseline |
| --- | --- |
| `client/src/terminal/` LOC (all `.ts`/`.tsx`) | **4481** |
| `@xterm/*` import sites in `client/src` | **19** |
| client files importing `@xterm/*` | **8** |
| Packages importing `@xterm/*` repo-wide | **4** (client, pty-host, terminal-themes, common*) |
| `@kolu/solid-xterm` LOC | 0 (does not exist) |
| `pnpm -r typecheck` | green (all 16 projects) |

\* `common` is a type-only structural augmentation (`KoluXtermProbe`), no runtime import.

### The 8 coupled client files (the wiring to pull into the socket)

| File | Loc | xterm coupling |
| --- | --- | --- |
| `terminal/Terminal.tsx` | 950 | constructs `XTerm` + 8 addons; WebGL lifecycle; keyboard/touch; link provider; private buffer probe |
| `terminal/SearchBar.tsx` | 175 | drives `SearchAddon` |
| `terminal/webglTracker.ts` | 222 | debug ledger for WebglAddon canvases |
| `terminal/useTerminalDiagnostics.ts` | 78 | reactive cols/rows/renderer off `XTerm` |
| `terminal/terminalRefs.ts` | 50 | imperative registry of live `XTerm` + `SerializeAddon` |
| `terminal/fileRefLinkProvider.ts` | 60 | `ILinkProvider` adapter (buffer to links) |
| `scrollLock.ts` | 120 | scroll-lock state machine over `Terminal` |
| `ui/clipboard.ts` | 111 | `SafeClipboardProvider` (`IClipboardProvider`) |

External xterm reach (via `terminalRefs`, no direct import yet but coupled to
xterm shapes): `exportScrollbackAsPdf.ts`, `screenshotTerminal.ts`,
`DiagnosticInfo.tsx`, `debug/consoleHooks.ts`.

## Methodology

LOC: `find packages/client/src/terminal -name '*.ts' -o -name '*.tsx' | xargs wc -l`.
Sites: `grep -rn '@xterm' packages/client/src --include='*.ts' --include='*.tsx' | wc -l`.
Typecheck gate: `nix develop path:. --quiet --command pnpm -r typecheck`.

## Optimization log

| Cycle | Change | terminal/ LOC | client @xterm files | typecheck |
| --- | --- | --- | --- | --- |
| baseline | none | 4481 | 8 | green |

## Dead ends

_(recorded as encountered)_

## Key findings

_(filled at wrap-up)_
