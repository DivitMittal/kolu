import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listAll, readFile } from "./browse.ts";

function git(cwd: string, args: string[]) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

describe("readFile", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kolu-readfile-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("reads file content", async () => {
    fs.writeFileSync(path.join(tmpDir, "hello.txt"), "world\n");
    const result = await readFile(tmpDir, "hello.txt");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.content).toBe("world\n");
    expect(result.value.truncated).toBe(false);
  });

  it("rejects path traversal", async () => {
    const result = await readFile(tmpDir, "../../etc/passwd");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("PATH_ESCAPES_ROOT");
    }
  });

  it("returns error for non-existent file", async () => {
    const result = await readFile(tmpDir, "nope.txt");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe("GIT_FAILED");
    }
  });
});

describe("listAll", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kolu-listall-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("omits tracked files deleted from the worktree", async () => {
    const repo = fs.mkdtempSync(path.join(tmpDir, "repo-"));
    git(repo, ["init"]);
    fs.writeFileSync(path.join(repo, "tracked.txt"), "stale\n");
    git(repo, ["add", "tracked.txt"]);
    git(repo, [
      "-c",
      "user.name=Kolu Test",
      "-c",
      "user.email=kolu@example.test",
      "commit",
      "-m",
      "init",
    ]);

    fs.unlinkSync(path.join(repo, "tracked.txt"));
    fs.writeFileSync(path.join(repo, "loose.txt"), "live\n");

    const result = await listAll(repo);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toContain("loose.txt");
    expect(result.value).not.toContain("tracked.txt");
  });
});
