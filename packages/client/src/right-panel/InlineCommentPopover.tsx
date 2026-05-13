/** Line-anchored inline composer — opens when the user clicks the
 *  "+" bubble next to a selected line, or the "💬" bubble next to a
 *  queued comment, or via the right-click "Add comment" menu, or via
 *  the tray pencil. Pins to the line's `[data-selected-line]`
 *  element via `getBoundingClientRect`, re-measures on scroll/resize,
 *  portals to `<body>` so it isn't clipped by the viewer's
 *  `overflow: hidden`.
 *
 *  Pierre's diff renderer attaches an open shadow root to its
 *  `<diffs-container>` custom element, so the lookup walks shadow
 *  trees too (`deepQuerySelector`). */

import {
  type Component,
  createEffect,
  createSignal,
  onCleanup,
  Show,
} from "solid-js";
import { Portal } from "solid-js/web";
import type { Comment } from "./commentSerialize";
import CommentComposer from "./CommentComposer";
import { deepQuerySelector } from "./LineCommentMarker";

/** Discriminated edit target — what the popover is currently editing. */
export type InlineEditTarget =
  | { kind: "new"; path: string; startLine: number; endLine: number }
  | { kind: "edit"; comment: Comment };

export type InlineCommentPopoverProps = {
  viewerEl: () => HTMLElement | null;
  target: () => InlineEditTarget | null;
  onSubmit: (text: string) => void;
  onClose: () => void;
};

const InlineCommentPopover: Component<InlineCommentPopoverProps> = (props) => {
  const [pos, setPos] = createSignal<{ left: number; top: number } | null>(
    null,
  );

  const measure = () => {
    if (props.target() === null) {
      setPos(null);
      return;
    }
    const root = props.viewerEl();
    if (!root) {
      setPos(null);
      return;
    }
    // Viewer hidden (right panel collapsed or inspector tab) → don't
    // orphan the popover over the canvas. Bail until viewer reappears.
    const vrect = root.getBoundingClientRect();
    if (vrect.width === 0 || vrect.height === 0) {
      setPos(null);
      return;
    }
    const sel = deepQuerySelector(root, "[data-selected-line]");
    if (!sel) {
      setPos(null);
      return;
    }
    // The selected `<code>` element fills the full grid row, so its
    // bounding rect.right is the viewer edge — useless for anchoring
    // "to the right of the line". A DOM Range over the content gives
    // a tight box around just the text.
    const lineRect = sel.getBoundingClientRect();
    const range = document.createRange();
    range.selectNodeContents(sel);
    const textRect = range.getBoundingClientRect();
    range.detach();
    const anchorRight = textRect.width > 0 ? textRect.right : lineRect.left + 8;
    // Clamp to viewport so a long line doesn't push past the right
    // edge. POPOVER_WIDTH matches CommentComposer's `w-[280px]`.
    const POPOVER_WIDTH = 280;
    const maxLeft = window.innerWidth - POPOVER_WIDTH - 12;
    const left = Math.min(anchorRight + 12, Math.max(maxLeft, 12));
    setPos({ left, top: lineRect.top });
  };

  createEffect(() => {
    props.target();
    let tries = 0;
    const attempt = () => {
      if (props.target() === null) return;
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
    <Show when={props.target() && pos()}>
      {(_) => {
        const t = props.target();
        const p = pos();
        if (!t || !p) return null;
        const range =
          t.kind === "edit"
            ? { start: t.comment.startLine, end: t.comment.endLine }
            : { start: t.startLine, end: t.endLine };
        const path = t.kind === "edit" ? t.comment.path : t.path;
        const initialText = t.kind === "edit" ? t.comment.text : "";
        return (
          <Portal>
            <div
              style={{
                position: "fixed",
                left: `${p.left}px`,
                top: `${p.top}px`,
                "z-index": "50",
              }}
              data-testid="inline-comment-popover"
            >
              <CommentComposer
                path={path}
                startLine={range.start}
                endLine={range.end}
                initialText={initialText}
                onSubmit={props.onSubmit}
                onCancel={props.onClose}
              />
            </div>
          </Portal>
        );
      }}
    </Show>
  );
};

export default InlineCommentPopover;
