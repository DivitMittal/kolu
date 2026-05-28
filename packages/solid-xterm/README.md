# @kolu/solid-xterm

Solid-native pieces of xterm.js lifecycle, extracted out of Kolu's
`Terminal.tsx`. Each helper encapsulates an independently-volatile
xterm/browser axis so the consumer doesn't have to re-derive the
workaround the next time the browser or xterm changes underneath it.

The package follows the same precedent as
[`@kolu/surface`](https://kolu.dev/blog/surface-framework/) and
`@kolu/solid-pierre`: single-consumer inside Kolu today, extracted for
volatility encapsulation, not reuse-count.

## Exports

- `./` — barrel re-exporting everything below.
- `./webgl` — `createXtermWebgl(getTerm, hooks) → XtermWebglHandle`.

## `createXtermWebgl`

Manages a single xterm `WebglAddon` lifecycle for a given terminal.
Encapsulates two recurring failure modes:

1. **xterm's link-layer canvas vs. WebGL canvas selector trap.** xterm
   appends a `.xterm-link-layer` 2D canvas inside `.xterm-screen`
   before its own WebGL canvas. A naive `querySelector(".xterm-screen
   canvas")` returns the link layer, whose `getContext("webgl2")`
   returns `null`, silently short-circuiting the
   `WEBGL_lose_context.loseContext()` call on unload. The helper
   selects with `:not(.xterm-link-layer)` to grab the real canvas.

2. **Chrome's per-tab GPU context budget (~16).** xterm's
   `WebglAddon.dispose()` removes the canvas from the DOM but does
   NOT call `loseContext()`, so Chrome keeps the context alive on the
   detached canvas until GC. Rapid focus changes overflow the budget
   and Chrome starts evicting live contexts. The helper explicitly
   calls `WEBGL_lose_context.loseContext()` before `addon.dispose()`,
   releasing GPU memory in the current microtask.

Hooks (`onCreate`, `onLoseContextCalled`, `onDispose`) let a host
observe canvas instances without coupling the framework to a
particular debug ledger. Kolu wires them into its temporary `#591`
zombie-context tracker.

```ts
const lifecycle = createXtermWebgl(() => myTerm, {
  onCreate: (canvas) => myObserver.note(canvas),
});

if (capability.allowsWebgl()) lifecycle.load();
// later, on focus loss:
lifecycle.unload();
// reactive accessor:
const isWebgl = lifecycle.has;
```

The handle owns its own SolidJS signal for `has`, so call sites can
read `lifecycle.has()` reactively without an extra `createMemo`.
