import { describe, expect, it } from "vitest";
import { type Comment, serializeComments } from "./commentSerialize";

const sample = (overrides: Partial<Comment> = {}): Comment => ({
  id: "c1",
  path: "src/foo.ts",
  startLine: 10,
  endLine: 10,
  text: "tighten this",
  createdAt: 0,
  ...overrides,
});

describe("serializeComments", () => {
  it("renders a Markdown bullet per comment with a code-spanned path:range ref (agent-native, no L prefix)", () => {
    expect(
      serializeComments([
        sample({ startLine: 12, endLine: 18, text: "shorten" }),
      ]),
    ).toBe("- `src/foo.ts:12-18` — shorten\n");
  });

  it("emits single-line refs as bare start (no -end suffix)", () => {
    expect(serializeComments([sample({ startLine: 42, endLine: 42 })])).toBe(
      "- `src/foo.ts:42` — tighten this\n",
    );
  });

  it("sorts by (path, startLine) so the paste reads as a repo walk, not click order", () => {
    const out = serializeComments([
      sample({
        id: "b",
        path: "src/zzz.ts",
        startLine: 5,
        endLine: 5,
        text: "B",
      }),
      sample({
        id: "c",
        path: "src/aaa.ts",
        startLine: 100,
        endLine: 100,
        text: "C",
      }),
      sample({
        id: "a",
        path: "src/aaa.ts",
        startLine: 7,
        endLine: 7,
        text: "A",
      }),
    ]);
    expect(out).toBe(
      "- `src/aaa.ts:7` — A\n- `src/aaa.ts:100` — C\n- `src/zzz.ts:5` — B\n",
    );
  });

  it("returns the empty string when the list is empty (defensive — Copy button is disabled in that case)", () => {
    expect(serializeComments([])).toBe("");
  });
});
