/** Clipboard payload — a Markdown bullet list (`- \`path:Lrange\` — text`)
 *  sorted by (path, startLine) so the paste reads as a repo walk, not
 *  click order. Plain Markdown by design: the user (or an agent prompt
 *  template) decides what prefix or framing wraps the list. */

import { formatLPathRef } from "../ui/lineRef";

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
        `- \`${formatLPathRef(c.path, c.startLine, c.endLine)}\` — ${c.text}`,
    )
    .join("\n")}\n`;
}
