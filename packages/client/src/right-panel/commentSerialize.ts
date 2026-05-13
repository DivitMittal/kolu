/** Clipboard payload — a Markdown bullet list (`- \`path:N-M\` — text`)
 *  sorted by (path, startLine) so the paste reads as a repo walk, not
 *  click order. Plain Markdown by design: the user (or an agent prompt
 *  template) decides what prefix or framing wraps the list.
 *
 *  Line refs use `path:N` (not `path:LN`) because that's the agent-CLI
 *  lingua franca — what `grep -n`, ripgrep, stack traces, VS Code, and
 *  vim all emit, and what `claude` / `codex` / `opencode` parse natively
 *  for their `Read` tools. The `LN` GitHub-permalink flavor is a URL
 *  thing and gains nothing in a paste-to-terminal flow. */

import { formatLineRef } from "../ui/lineRef";

export type Comment = {
  id: string;
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  createdAt: number;
};

export function serializeComments(comments: readonly Comment[]): string {
  if (comments.length === 0) return "";
  const sorted = [...comments].sort((a, b) => {
    if (a.path !== b.path) return a.path.localeCompare(b.path);
    return a.startLine - b.startLine;
  });
  return `${sorted
    .map(
      (c) =>
        `- \`${formatLineRef(c.path, c.startLine, c.endLine)}\` — ${c.text}`,
    )
    .join("\n")}\n`;
}
