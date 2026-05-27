/**
 * `unwrapGit` — convert `kolu-git`'s tagged `GitResult<T>` into a plain
 * value (or throw `ORPCError` for the failure code mapping). Extracted
 * out of `surface.ts` so the stdio agent (which deliberately doesn't
 * import `surface.ts` — that module has top-level side effects: Conf
 * stores, LocalTerminalBackend instantiation, autosave loop) can reuse
 * the same error-shape mapping the parent's RPC handlers use.
 */

import { ORPCError } from "@orpc/server";
import type { GitResult } from "kolu-git";
import { match } from "ts-pattern";

export function unwrapGit<T>(result: GitResult<T>): T {
  if (result.ok) return result.value;
  const { status, message } = match(result.error)
    .with({ code: "BASE_BRANCH_NOT_FOUND" }, (e) => ({
      status: "PRECONDITION_FAILED" as const,
      message: e.message,
    }))
    .with({ code: "WORKTREE_NAME_COLLISION" }, (e) => ({
      status: "CONFLICT" as const,
      message: e.message,
    }))
    .with({ code: "PATH_ESCAPES_ROOT" }, (e) => ({
      status: "INTERNAL_SERVER_ERROR" as const,
      message: `path escapes root: ${e.child}`,
    }))
    .with({ code: "GIT_FAILED" }, (e) => ({
      status: "INTERNAL_SERVER_ERROR" as const,
      message: e.message,
    }))
    .with({ code: "NOT_A_REPO" }, () => ({
      status: "INTERNAL_SERVER_ERROR" as const,
      message: "Not a git repository",
    }))
    .exhaustive();
  throw new ORPCError(status, { message });
}
