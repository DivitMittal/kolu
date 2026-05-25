import type { TerminalId } from "kolu-common/surface";
import { describe, expect, it } from "vitest";
import type { TerminalDisplayInfo } from "../../terminal/terminalDisplay";
import {
  buildDockTree,
  flattenForRender,
  flattenTerminalIds,
} from "./dockTree";
import type { DockRowBucket, RankedDockRow } from "./dockRowRanking";

/** Minimal display-info fake: only the fields `buildDockTree` reads. */
function info(
  group: string,
  label: string,
  color = "#fff",
): TerminalDisplayInfo {
  return {
    repoColor: color,
    branchColor: color,
    annotationColor: color,
    meta: {
      cwd: "/tmp",
      git: null,
      pr: { kind: "absent" },
      agent: null,
      foreground: null,
      lastActivityAt: 0,
    },
    subCount: 0,
    key: { group, label },
  };
}

function row(
  id: string,
  ts: number,
  bucket: DockRowBucket = "none",
): RankedDockRow {
  return { id: id as TerminalId, bucket, ts };
}

describe("buildDockTree — single repo, single branch", () => {
  it("collapses to one header labelled 'REPO · branch' with terminals as direct children", () => {
    const ranked = [row("t1", 5), row("t2", 3)];
    const map = new Map<string, TerminalDisplayInfo>([
      ["t1", info("kolu", "dock-tree")],
      ["t2", info("kolu", "dock-tree")],
    ]);
    const tree = buildDockTree(ranked, (id) => map.get(id));
    expect(tree).toHaveLength(1);
    const top = tree[0];
    if (!top || top.kind !== "group") throw new Error("expected group");
    expect(top.label).toBe("kolu · dock-tree");
    expect(top.depth).toBe(0);
    expect(top.terminalCount).toBe(2);
    expect(top.recency).toBe(5);
    expect(top.children.map((c) => c.kind)).toEqual(["terminal", "terminal"]);
  });
});

describe("buildDockTree — single repo, multiple branches", () => {
  it("nests a branch sub-header under the repo, ordered by max-recency", () => {
    const ranked = [
      row("t1", 10), // dock-tree
      row("t2", 3), // master
      row("t3", 8), // dock-tree
    ];
    const map = new Map<string, TerminalDisplayInfo>([
      ["t1", info("kolu", "dock-tree")],
      ["t2", info("kolu", "master")],
      ["t3", info("kolu", "dock-tree")],
    ]);
    const tree = buildDockTree(ranked, (id) => map.get(id));
    expect(tree).toHaveLength(1);
    const top = tree[0];
    if (!top || top.kind !== "group") throw new Error("expected group");
    expect(top.label).toBe("kolu");
    expect(top.children).toHaveLength(2);
    const [first, second] = top.children;
    if (!first || first.kind !== "group") throw new Error("expected group");
    if (!second || second.kind !== "group") throw new Error("expected group");
    // dock-tree leads master: max-recency 10 vs 3
    expect(first.label).toBe("dock-tree");
    expect(first.depth).toBe(1);
    expect(first.terminalCount).toBe(2);
    expect(second.label).toBe("master");
    expect(second.depth).toBe(1);
    expect(second.terminalCount).toBe(1);
  });
});

describe("buildDockTree — multiple repos", () => {
  it("orders top-level groups by max-recency descending", () => {
    const ranked = [row("a", 1), row("b", 10), row("c", 5)];
    const map = new Map<string, TerminalDisplayInfo>([
      ["a", info("dots", "master")],
      ["b", info("agency", "main")],
      ["c", info("kolu", "dock-tree")],
    ]);
    const tree = buildDockTree(ranked, (id) => map.get(id));
    expect(tree.map((g) => (g.kind === "group" ? g.label : null))).toEqual([
      "agency · main",
      "kolu · dock-tree",
      "dots · master",
    ]);
  });
});

describe("buildDockTree — order within a leaf", () => {
  it("preserves the input ranked order — does not re-sort terminals", () => {
    // Bucket priority is the secondary key in `rankDockRows`; preserving
    // input order means parked rows stay at the bottom of their leaf even
    // though their `ts` may exceed an awaiting row that ranks above them.
    const ranked = [
      row("awaiting", 0, "awaiting"),
      row("working", 0, "working"),
      row("idle", 0, "idle"),
      row("parked", 0, "parked"),
    ];
    const map = new Map<string, TerminalDisplayInfo>([
      ["awaiting", info("kolu", "master")],
      ["working", info("kolu", "master")],
      ["idle", info("kolu", "master")],
      ["parked", info("kolu", "master")],
    ]);
    const tree = buildDockTree(ranked, (id) => map.get(id));
    const top = tree[0];
    if (!top || top.kind !== "group") throw new Error("expected group");
    expect(
      top.children.map((c) => (c.kind === "terminal" ? c.id : null)),
    ).toEqual(["awaiting", "working", "idle", "parked"]);
  });
});

describe("buildDockTree — missing display info", () => {
  it("drops terminals whose display info hasn't arrived yet", () => {
    const ranked = [row("present", 1), row("missing", 2)];
    const map = new Map<string, TerminalDisplayInfo>([
      ["present", info("kolu", "master")],
    ]);
    const tree = buildDockTree(ranked, (id) => map.get(id));
    expect(tree).toHaveLength(1);
    const top = tree[0];
    if (!top || top.kind !== "group") throw new Error("expected group");
    expect(top.terminalCount).toBe(1);
  });
});

describe("buildDockTree — empty input", () => {
  it("returns an empty tree", () => {
    expect(buildDockTree([], () => undefined)).toEqual([]);
  });
});

describe("flattenForRender", () => {
  it("emits headers before their terminals and pairs each terminal with its index", () => {
    const ranked = [row("t1", 10), row("t2", 5)];
    const map = new Map<string, TerminalDisplayInfo>([
      ["t1", info("kolu", "dock-tree")],
      ["t2", info("agency", "main")],
    ]);
    const tree = buildDockTree(ranked, (id) => map.get(id));
    const items = flattenForRender(tree, () => false);
    expect(items.map((i) => i.kind)).toEqual([
      "group-header",
      "terminal",
      "group-header",
      "terminal",
    ]);
    const terminals = items.filter((i) => i.kind === "terminal");
    expect(
      terminals.map((t) => (t.kind === "terminal" ? t.index : -1)),
    ).toEqual([0, 1]);
  });

  it("hides children of folded groups but preserves index slots so Cmd+N stays aligned", () => {
    // Two repos × one terminal each. Fold the first; the second
    // terminal must still report index 1 (matching its slot in
    // flattenTerminalIds), not 0.
    const ranked = [row("t1", 10), row("t2", 5)];
    const map = new Map<string, TerminalDisplayInfo>([
      ["t1", info("kolu", "dock-tree")],
      ["t2", info("agency", "main")],
    ]);
    const tree = buildDockTree(ranked, (id) => map.get(id));
    const items = flattenForRender(tree, (key) => key === "kolu");
    // The folded group's header still renders; its terminal does not.
    const headers = items.filter((i) => i.kind === "group-header");
    expect(headers).toHaveLength(2);
    const terminals = items.filter((i) => i.kind === "terminal");
    expect(terminals).toHaveLength(1);
    expect(terminals[0]?.kind === "terminal" ? terminals[0].index : -1).toBe(1);
  });
});

describe("flattenTerminalIds", () => {
  it("walks the tree depth-first and returns terminal ids in render order", () => {
    const ranked = [row("t1", 10), row("t2", 9), row("t3", 8), row("t4", 7)];
    const map = new Map<string, TerminalDisplayInfo>([
      ["t1", info("kolu", "dock-tree")],
      ["t2", info("kolu", "master")],
      ["t3", info("agency", "main")],
      ["t4", info("agency", "feature")],
    ]);
    const tree = buildDockTree(ranked, (id) => map.get(id));
    const ids = flattenTerminalIds(tree);
    expect(ids).toEqual(["t1", "t2", "t3", "t4"]);
  });

  it("returns an empty list for an empty tree", () => {
    expect(flattenTerminalIds([])).toEqual([]);
  });
});
