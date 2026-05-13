/** A tiny floating button anchored to the right side of a code line.
 *  Two roles, one component:
 *    - "+" on the currently-selected line → click opens a fresh
 *      composer (the user-confirmed click that replaces the old
 *      auto-popover-on-select).
 *    - "💬" on lines that carry a queued comment → click re-opens
 *      the composer in edit mode at that comment.
 *
 *  Positioning mirrors `InlineCommentPopover` — a `DOM Range` over the
 *  line's text gives a tight bounding box (the line `<code>` itself is
 *  the full grid row, useless for "right of the line"). Walks open
 *  shadow roots because Pierre's diff renderer puts everything inside
 *  `<diffs-container>`'s shadow tree. */

import {
  type Component,
  createEffect,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";

export type LineCommentMarkerProps = {
  /** Viewer scroll-root — search scope for the line lookup. */
  viewerEl: () => HTMLElement | null;
  /** Reactive key that re-triggers measure when it changes (e.g. the
   *  selected line's range, or a comment's id+startLine). Returning
   *  `null` hides the marker. */
  key: () => string | null;
  /** Returns the line's content element under the current viewer, or
   *  null if the line isn't rendered (virtualized out, or the
   *  selection hasn't landed yet). */
  resolveLine: () => HTMLElement | null;
  /** Visible glyph — "+" for new, "💬" for existing. */
  label: string;
  title: string;
  /** Click handler — caller switches to the composer. */
  onClick: () => void;
  /** data-testid for e2e selectors. */
  testid?: string;
};

const deepQuerySelector = (
  root: HTMLElement | ShadowRoot,
  selector: string,
): HTMLElement | null => {
  const direct = root.querySelector<HTMLElement>(selector);
  if (direct) return direct;
  for (const host of root.querySelectorAll<HTMLElement>("*")) {
    const sr = host.shadowRoot;
    if (!sr) continue;
    const found = deepQuerySelector(sr, selector);
    if (found) return found;
  }
  return null;
};

export { deepQuerySelector };

const LineCommentMarker: Component<LineCommentMarkerProps> = (props) => {
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(
    null,
  );

  const measure = () => {
    const key = props.key();
    if (!key) {
      setPos(null);
      return;
    }
    const viewer = props.viewerEl();
    if (!viewer) {
      setPos(null);
      return;
    }
    // Viewer hidden (right panel collapsed, inspector tab active) →
    // its layout rect collapses. Don't render an orphan marker over
    // unrelated UI.
    const vrect = viewer.getBoundingClientRect();
    if (vrect.width === 0 || vrect.height === 0) {
      setPos(null);
      return;
    }
    const line = props.resolveLine();
    if (!line) {
      setPos(null);
      return;
    }
    const lineRect = line.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(line);
    const textRect = range.getBoundingClientRect();
    range.detach();
    const anchorRight = textRect.width > 0 ? textRect.right : lineRect.left + 8;
    setPos({ left: anchorRight + 8, top: lineRect.top });
  };

  // Re-measure when the key changes (selected line moved, comment
  // added/removed, file switched). Pierre's selection DOM commits
  // through `requestAnimationFrame`; retry a handful of frames so we
  // don't race the rAF.
  createEffect(() => {
    props.key();
    let tries = 0;
    const attempt = () => {
      if (props.key() === null) return;
      measure();
      if (pos() !== null) return;
      if (tries++ > 10) return;
      requestAnimationFrame(attempt);
    };
    attempt();
  });

  const onScroll = () => measure();
  window.addEventListener("scroll", onScroll, true);
  window.addEventListener("resize", onScroll);
  onCleanup(() => {
    window.removeEventListener("scroll", onScroll, true);
    window.removeEventListener("resize", onScroll);
  });

  return (
    <Show when={pos()}>
      {(p) => (
        <Portal>
          <button
            type="button"
            style={{
              position: "fixed",
              left: `${p().left}px`,
              top: `${p().top - 2}px`,
              "z-index": "40",
            }}
            class="flex items-center justify-center min-w-[20px] h-5 px-1.5 rounded-full bg-accent text-bg-0 text-[10px] font-medium shadow-md hover:scale-110 transition-transform cursor-pointer"
            title={props.title}
            data-testid={props.testid}
            onClick={(e) => {
              e.stopPropagation();
              props.onClick();
            }}
          >
            {props.label}
          </button>
        </Portal>
      )}
    </Show>
  );
};

export default LineCommentMarker;
