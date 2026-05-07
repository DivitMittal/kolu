import { terminalKey } from "kolu-common/terminalKey";
import type { GitInfo } from "kolu-git/schemas";
import { describe, expect, it } from "vitest";
import {
  arrangeRepoIslands,
  placeNewTileInRepoIsland,
  type RepoIslandTerminalSnapshot,
  type RepoIslandTile,
} from "./repoIslandPlacement";

function tile(
  id: string,
  group: string,
  layout: { x: number; y: number; w: number; h: number },
): RepoIslandTile {
  return { id, group, layout };
}

function randomSequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++] ?? 0;
}

function git(root: string, overrides: Partial<GitInfo> = {}): GitInfo {
  return {
    repoRoot: root,
    repoName: "kolu",
    worktreePath: root,
    branch: "main",
    isWorktree: false,
    mainRepoRoot: root,
    ...overrides,
  };
}

function terminal(
  id: string,
  cwd: string,
  layout?: { x: number; y: number; w: number; h: number },
  gitInfo: GitInfo | null = null,
): RepoIslandTerminalSnapshot {
  return {
    id,
    cwd,
    git: gitInfo,
    key: terminalKey({ git: gitInfo, cwd }),
    layout,
  };
}

describe("placeNewTileInRepoIsland", () => {
  it("places a new terminal beside the active repo island", () => {
    const layout = placeNewTileInRepoIsland({
      cwd: "/repo",
      activeId: "a",
      terminals: [
        terminal("a", "/repo", { x: 96, y: 48, w: 300, h: 200 }),
        terminal("b", "/other", { x: 2000, y: 2000, w: 300, h: 200 }),
      ],
    });

    expect(layout).toEqual({ x: 432, y: 48, w: 800, h: 540 });
  });

  it("uses the whole matching island as the anchor", () => {
    const layout = placeNewTileInRepoIsland({
      cwd: "/repo",
      activeId: "a",
      terminals: [
        terminal("a", "/repo", { x: 0, y: 240, w: 800, h: 540 }),
        terminal("b", "/repo", { x: 840, y: 0, w: 640, h: 360 }),
      ],
    });

    expect(layout).toEqual({ x: 1512, y: 0, w: 800, h: 540 });
  });

  it("moves down when another tile already occupies the adjacent spot", () => {
    const layout = placeNewTileInRepoIsland({
      cwd: "/repo",
      activeId: "a",
      terminals: [
        terminal("a", "/repo", { x: 0, y: 0, w: 800, h: 540 }),
        terminal("b", "/other", { x: 840, y: 0, w: 800, h: 540 }),
      ],
    });

    expect(layout).toEqual({ x: 840, y: 576, w: 800, h: 540 });
  });

  it("matches cwd inside an existing git repo root", () => {
    const layout = placeNewTileInRepoIsland({
      cwd: "/repo/.worktrees/feature",
      activeId: "other",
      terminals: [
        terminal("repo", "/repo", { x: 0, y: 0, w: 800, h: 540 }, git("/repo")),
        terminal("other", "/tmp", { x: 2000, y: 0, w: 800, h: 540 }),
      ],
    });

    expect(layout).toEqual({ x: 840, y: 0, w: 800, h: 540 });
  });

  it("prefers the most specific git root when repo roots are nested", () => {
    const layout = placeNewTileInRepoIsland({
      cwd: "/repo/packages/app/src",
      activeId: "other",
      terminals: [
        terminal(
          "parent",
          "/repo",
          { x: 0, y: 0, w: 800, h: 540 },
          git("/repo", { repoName: "parent" }),
        ),
        terminal(
          "child",
          "/repo/packages/app",
          { x: 2000, y: 0, w: 800, h: 540 },
          git("/repo/packages/app", { repoName: "child" }),
        ),
        terminal("other", "/tmp", { x: 4000, y: 0, w: 800, h: 540 }),
      ],
    });

    expect(layout).toEqual({ x: 2832, y: 0, w: 800, h: 540 });
  });

  it("falls back when there is no matching laid-out island", () => {
    expect(
      placeNewTileInRepoIsland({
        cwd: "/repo",
        activeId: "a",
        terminals: [terminal("a", "/repo")],
      }),
    ).toBeUndefined();
    expect(
      placeNewTileInRepoIsland({
        cwd: "/missing",
        activeId: "a",
        terminals: [terminal("a", "/repo", { x: 0, y: 0, w: 800, h: 540 })],
      }),
    ).toBeUndefined();
  });
});

describe("arrangeRepoIslands", () => {
  it("packs terminals from the same repo into a square-ish grid", () => {
    const arranged = arrangeRepoIslands(
      [
        tile("a", "kolu", { x: 0, y: 0, w: 96, h: 72 }),
        tile("b", "kolu", { x: 500, y: 0, w: 96, h: 72 }),
        tile("c", "kolu", { x: 0, y: 500, w: 96, h: 72 }),
        tile("d", "kolu", { x: 500, y: 500, w: 96, h: 72 }),
      ],
      { tileGap: 24, originX: 0, originY: 0 },
    );

    expect([...arranged.values()]).toEqual([
      { x: 0, y: 0, w: 96, h: 72 },
      { x: 120, y: 0, w: 96, h: 72 },
      { x: 0, y: 96, w: 96, h: 72 },
      { x: 120, y: 96, w: 96, h: 72 },
    ]);
  });

  it("packs repo clusters into a square-ish outer grid", () => {
    const arranged = arrangeRepoIslands(
      [
        tile("a", "alpha", { x: 0, y: 0, w: 96, h: 72 }),
        tile("b", "alpha", { x: 0, y: 0, w: 96, h: 72 }),
        tile("c", "beta", { x: 0, y: 0, w: 96, h: 72 }),
        tile("d", "gamma", { x: 0, y: 0, w: 96, h: 72 }),
        tile("e", "delta", { x: 0, y: 0, w: 96, h: 72 }),
      ],
      { tileGap: 24, groupGap: 48, groupJitter: 0, originX: 0, originY: 0 },
    );

    expect(arranged.get("a")).toEqual({ x: 0, y: 0, w: 96, h: 72 });
    expect(arranged.get("b")).toEqual({ x: 120, y: 0, w: 96, h: 72 });
    expect(arranged.get("c")).toEqual({ x: 264, y: 0, w: 96, h: 72 });
    expect(arranged.get("d")).toEqual({ x: 0, y: 120, w: 96, h: 72 });
    expect(arranged.get("e")).toEqual({ x: 264, y: 120, w: 96, h: 72 });
  });

  it("preserves current tile sizes", () => {
    const arranged = arrangeRepoIslands([
      tile("a", "kolu", { x: 10, y: 20, w: 601, h: 421 }),
      tile("b", "kolu", { x: 900, y: 20, w: 523, h: 367 }),
      tile("c", "kolu", { x: 10, y: 900, w: 733, h: 511 }),
    ]);

    expect(arranged.get("a")).toMatchObject({ w: 601, h: 421 });
    expect(arranged.get("b")).toMatchObject({ w: 523, h: 367 });
    expect(arranged.get("c")).toMatchObject({ w: 733, h: 511 });
  });

  it("defaults to compact same-repo spacing and island-like repo separation", () => {
    const arranged = arrangeRepoIslands(
      [
        tile("a", "alpha", { x: 0, y: 0, w: 96, h: 72 }),
        tile("b", "alpha", { x: 0, y: 0, w: 96, h: 72 }),
        tile("c", "beta", { x: 0, y: 0, w: 96, h: 72 }),
      ],
      { originX: 0, originY: 0 },
    );

    const first = arranged.get("a");
    const second = arranged.get("b");
    const otherRepo = arranged.get("c");
    if (!first || !second || !otherRepo) {
      throw new Error("Expected all arranged layouts to be present");
    }
    expect(first).toMatchObject({ w: 96, h: 72 });
    expect(second).toMatchObject({ w: 96, h: 72 });
    expect(otherRepo).toMatchObject({ w: 96, h: 72 });
    expect(second.x - (first.x + first.w)).toBe(24);
    expect(second.y).toBe(first.y);
    expect(otherRepo.x - (second.x + second.w)).toBeGreaterThanOrEqual(768);
    expect(first.x % 24).toBe(0);
    expect(otherRepo.x % 24).toBe(0);
  });

  it("can randomize repo island positions while keeping grid alignment", () => {
    const tiles = [
      tile("a", "alpha", { x: 0, y: 0, w: 96, h: 72 }),
      tile("b", "alpha", { x: 0, y: 0, w: 96, h: 72 }),
      tile("c", "beta", { x: 0, y: 0, w: 96, h: 72 }),
    ];
    const plain = arrangeRepoIslands(tiles, {
      originX: 0,
      originY: 0,
      random: randomSequence([0, 0, 0, 0]),
    });
    const scattered = arrangeRepoIslands(tiles, {
      originX: 0,
      originY: 0,
      random: randomSequence([0, 0, 0.99, 0.99]),
    });

    expect(scattered.get("a")).toEqual(plain.get("a"));
    expect(scattered.get("b")).toEqual(plain.get("b"));
    expect(scattered.get("c")).toEqual({ x: 1368, y: 192, w: 96, h: 72 });
  });

  it("anchors the arrangement at the existing bounding origin by default", () => {
    const arranged = arrangeRepoIslands([
      tile("a", "kolu", { x: 288, y: 432, w: 96, h: 72 }),
      tile("b", "kolu", { x: 912, y: 120, w: 96, h: 72 }),
    ]);

    expect(arranged.get("a")).toEqual({ x: 288, y: 120, w: 96, h: 72 });
  });
});
