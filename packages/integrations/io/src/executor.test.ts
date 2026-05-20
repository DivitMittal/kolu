import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localExecutor } from "./executor.ts";

describe("localExecutor.readFile", () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kolu-io-test-"));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns a truncated prefix when maxBytes is smaller than the file", async () => {
    const filePath = path.join(tmpDir, "long.txt");
    fs.writeFileSync(filePath, "abcdef");

    await expect(
      localExecutor.readFile(filePath, { maxBytes: 3 }),
    ).resolves.toEqual({
      content: "abc",
      truncated: true,
    });
  });

  it("does not mark exact-size reads as truncated", async () => {
    const filePath = path.join(tmpDir, "exact.txt");
    fs.writeFileSync(filePath, "abc");

    await expect(
      localExecutor.readFile(filePath, { maxBytes: 3 }),
    ).resolves.toEqual({
      content: "abc",
      truncated: false,
    });
  });
});
