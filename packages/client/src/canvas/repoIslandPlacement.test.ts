import type { GitInfo } from "kolu-git/schemas";
import { describe, expect, it } from "vitest";
import {
  placeNewTileInRepoIsland,
  type RepoIslandTerminalSnapshot,
} from "./repoIslandPlacement";

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
  group: string | undefined,
  cwd: string,
  layout?: { x: number; y: number; w: number; h: number },
  gitInfo: GitInfo | null = null,
): RepoIslandTerminalSnapshot {
  return { id, group, cwd, layout, git: gitInfo };
}

describe("placeNewTileInRepoIsland", () => {
  it("places a new terminal beside the active repo island", () => {
    const layout = placeNewTileInRepoIsland({
      cwd: "/repo",
      activeId: "a",
      terminals: [
        terminal("a", "kolu", "/repo", { x: 96, y: 48, w: 300, h: 200 }),
        terminal("b", "other", "/other", {
          x: 2000,
          y: 2000,
          w: 300,
          h: 200,
        }),
      ],
    });

    expect(layout).toEqual({ x: 432, y: 48, w: 800, h: 540 });
  });

  it("uses the whole matching island as the anchor", () => {
    const layout = placeNewTileInRepoIsland({
      cwd: "/repo",
      activeId: "a",
      terminals: [
        terminal("a", "kolu", "/repo", { x: 0, y: 240, w: 800, h: 540 }),
        terminal("b", "kolu", "/repo", { x: 840, y: 0, w: 640, h: 360 }),
      ],
    });

    expect(layout).toEqual({ x: 1512, y: 0, w: 800, h: 540 });
  });

  it("moves down when another tile already occupies the adjacent spot", () => {
    const layout = placeNewTileInRepoIsland({
      cwd: "/repo",
      activeId: "a",
      terminals: [
        terminal("a", "kolu", "/repo", { x: 0, y: 0, w: 800, h: 540 }),
        terminal("b", "other", "/other", { x: 840, y: 0, w: 800, h: 540 }),
      ],
    });

    expect(layout).toEqual({ x: 840, y: 576, w: 800, h: 540 });
  });

  it("matches cwd inside an existing git repo root", () => {
    const layout = placeNewTileInRepoIsland({
      cwd: "/repo/.worktrees/feature",
      activeId: "other",
      terminals: [
        terminal(
          "repo",
          "kolu",
          "/repo",
          { x: 0, y: 0, w: 800, h: 540 },
          git("/repo"),
        ),
        terminal("other", "tmp", "/tmp", { x: 2000, y: 0, w: 800, h: 540 }),
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
          "parent",
          "/repo",
          { x: 0, y: 0, w: 800, h: 540 },
          git("/repo"),
        ),
        terminal(
          "child",
          "child",
          "/repo/packages/app",
          { x: 2000, y: 0, w: 800, h: 540 },
          git("/repo/packages/app"),
        ),
        terminal("other", "tmp", "/tmp", { x: 4000, y: 0, w: 800, h: 540 }),
      ],
    });

    expect(layout).toEqual({ x: 2832, y: 0, w: 800, h: 540 });
  });

  it("falls back when there is no matching laid-out island", () => {
    expect(
      placeNewTileInRepoIsland({
        cwd: "/repo",
        activeId: "a",
        terminals: [terminal("a", "kolu", "/repo")],
      }),
    ).toBeUndefined();
    expect(
      placeNewTileInRepoIsland({
        cwd: "/missing",
        activeId: "a",
        terminals: [
          terminal("a", "kolu", "/repo", { x: 0, y: 0, w: 800, h: 540 }),
        ],
      }),
    ).toBeUndefined();
  });
});
