/** Comment-mode toggle — a single global persisted boolean for "is the Code
 *  tab in comment-annotation mode right now?".
 *
 *  Split out from `useComments.ts` because the toggle is on a different
 *  volatility axis than the per-repoRoot comment buckets: the toggle is a
 *  session-wide UI preference (one Code tab in the right panel today),
 *  while the buckets are per-worktree user content. Co-locating them would
 *  fuse two independently-changing concerns into one module. */

import { makePersisted } from "@solid-primitives/storage";
import { type Accessor, createSignal } from "solid-js";

const [commentMode, setCommentMode] = makePersisted(createSignal(false), {
  name: "kolu-comment-mode",
  serialize: (v) => (v ? "1" : "0"),
  deserialize: (raw) => raw === "1",
});

export const commentModeEnabled: Accessor<boolean> = commentMode;

/** Symmetric with `toggleCommentMode` — there is no `enable` because the
 *  only way to enable today is the toolbar toggle, and there is no
 *  `setMode(bool)` because no caller needs to drive the raw value. */
export function disableCommentMode(): void {
  setCommentMode(false);
}

export function toggleCommentMode(): void {
  setCommentMode((v) => !v);
}
