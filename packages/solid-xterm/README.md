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
- `./style-sync` — `attachXtermStyleSync(getTerm, { theme, fontSize, onThemeChange, onFontSizeChange })`.
- `./scroll-lock` — `createScrollLock(enabled) → { isLocked, hasNewOutput, attachToTerminal, writeData, scrollToBottom, reset }`.

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

## `attachXtermStyleSync`

Reactively syncs `term.options.theme` and `term.options.fontSize` to
Solid-managed accessors. Initial values are skipped (`defer: true`)
— they're meant to come from the `XTerm` constructor on mount;
subsequent changes flow through.

Two post-change hooks let the consumer follow up on each axis
independently. The typical wiring:

- `onThemeChange`: clear the WebGL texture atlas (xterm #239 leaves
  stale glyph atlases after a palette swap).
- `onFontSizeChange`: clear the WebGL texture atlas *and* refit the
  grid (cell dimensions changed; FitAddon.fit() must republish the
  new cols/rows).

The hooks are separate because the theme axis has no fit
implication — collapsing them to a single `afterChange` would force
every consumer to refit on theme swap, which is unnecessary work in
the common case.

Must be called inside a SolidJS reactive owner (component body or
`runWithOwner` wrapper).

```ts
attachXtermStyleSync(() => myTerm, {
  theme: () => props.theme,
  fontSize: zoomedFontSize,
  onThemeChange: () => myWebgl.clearTextureAtlas(),
  onFontSizeChange: () => {
    myWebgl.clearTextureAtlas();
    fit();
  },
});
```

## `createScrollLock`

State machine that freezes incoming PTY writes when the user scrolls
up, and flushes the buffered data when they scroll back to the
bottom. Avoids the viewport-jumping bug class entirely — xterm
never sees the data until the user is at the bottom and ready to
see it.

The encapsulated axis: xterm's `Terminal.onScroll` event +
`buffer.active.baseY` vs `viewportY` math for the "at bottom"
check. Consumers gate writes through `writeData(term, data)`
instead of `term.write(data)` and the lock is transparent.

`attachToTerminal(term)` MUST be called synchronously within a
SolidJS reactive scope (component body, `onMount`, or a
`runWithOwner` restoring the captured owner). Outside a reactive
scope the `onCleanup` is a silent no-op and the `onScroll` closure
+ `termRef` leak the xterm Terminal for the rest of the page
lifetime.

```ts
const scrollLock = createScrollLock(() => preferences().scrollLock);
// inside onMount, with `term` constructed:
scrollLock.attachToTerminal(term);
// on every PTY data chunk:
scrollLock.writeData(term, chunk);
```
