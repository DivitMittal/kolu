/** Front door for "open this file in the mobile Files drawer". The
 *  desktop analog is `openInCodeTab` (right-panel scope); on mobile
 *  the right panel doesn't exist and `MobileCodeSheet` is the viewer.
 *
 *  Why a parallel module instead of an `isMobile()` branch inside
 *  `openInCodeTab`: that helper encapsulates the desktop right-panel
 *  paired writes (preferences-uncollapse + tab + browse-mode + pending
 *  request). Smuggling a mobile branch into it would complect platform
 *  dispatch with desktop-navigation policy. Producers that fire on
 *  both surfaces (today: the terminal `path:line` link provider and
 *  the touchstart-on-buffer-text handler) branch on `isMobile()` at
 *  the call site and route to whichever front door matches the surface.
 *
 *  The request carries the full `LineRef + repoRoot + cwd` so
 *  `MobileCodeSheet` can run `resolveLineRefPath` against the live
 *  `fsListAll` paths before selecting — terminal output emits
 *  absolute paths (`pwd`), cwd-relative paths (`error in foo.ts:42`
 *  while in a subdir), and basename-only references; passing the
 *  raw `ref.path` straight into `setSelectedFile` would push an
 *  un-resolvable string at `fsReadFile` and the server would reject
 *  with `path escapes root` or `EISDIR`. */

import type { CodeTabView } from "kolu-common/surface";
import { createSignal } from "solid-js";
import type { LineRef } from "./ui/lineRef";

export interface OpenInMobileFilesRequest {
  ref: LineRef;
  repoRoot: string;
  cwd?: string;
  /** Mode slot to write the resolved path into. Producers always pass
   *  `"browse"` today; the field is here so future modes (local diff
   *  inspection on mobile, say) don't need to refactor the contract. */
  targetMode: CodeTabView;
}

const [pending, setPending] = createSignal<OpenInMobileFilesRequest | null>(
  null,
);

/** Subscribe in `MobileTileView` to open the Files drawer when a
 *  producer requests navigation, and in `MobileCodeSheet` to resolve
 *  the request against `fsListAll` and write the selection slot. */
export const pendingMobileOpen = pending;

export function openInMobileFiles(req: OpenInMobileFilesRequest): void {
  // Mint a fresh object on every call so two clicks on the same
  // `path:line` (which would deep-equal) are distinguishable by
  // reference identity — `MobileCodeSheet`'s consume-once effect
  // tracks the request object, not its content.
  setPending({ ...req });
}
