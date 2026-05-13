/** Chrome-bar count badge — surfaces queued comments for the active
 *  terminal's worktree regardless of whether the right panel is open.
 *
 *  Click opens the Code tab + uncollapses the panel; the tray itself
 *  is already visible whenever `commentsApi.comments().length > 0`
 *  (via `trayVisible` in CodeTab), so no extra wiring is needed to
 *  scroll-to the queue. Renders nothing when count is zero, so the
 *  chrome bar stays uncluttered for users not actively reviewing. */

import { type Component, Show } from "solid-js";
import { CommentIcon } from "../ui/Icons";
import Tip from "../ui/Tip";
import { useComments } from "./useComments";
import { useRightPanel } from "./useRightPanel";

const CommentCountBadge: Component<{
  activeRepoRoot: () => string | null;
}> = (props) => {
  const rightPanel = useRightPanel();
  const commentsApi = useComments(props.activeRepoRoot);
  const count = () => commentsApi.comments().length;

  return (
    <Show when={count() > 0}>
      <Tip
        label={`${count()} queued comment${count() === 1 ? "" : "s"} — click to review`}
      >
        <button
          type="button"
          data-testid="comment-count-badge"
          class="pointer-events-auto flex items-center gap-1 px-2 h-7 rounded-lg bg-accent/15 text-accent hover:bg-accent/25 transition-colors cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
          onClick={() => rightPanel.openCodeBrowser()}
          aria-label={`${count()} queued comments`}
        >
          <CommentIcon class="w-3.5 h-3.5" />
          <span class="text-[11px] font-mono">{count()}</span>
        </button>
      </Tip>
    </Show>
  );
};

export default CommentCountBadge;
