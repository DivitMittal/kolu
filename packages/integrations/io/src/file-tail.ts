import type { Logger } from "kolu-shared";
import type { Executor } from "./executor.ts";

export async function statSizeBytes(
  executor: Executor,
  filePath: string,
  log?: Logger,
): Promise<number | null> {
  try {
    return await executor.statSizeBytes(filePath);
  } catch (err) {
    log?.debug({ err, filePath }, "file size query failed");
    return null;
  }
}

export async function readRange(
  executor: Executor,
  filePath: string,
  offset: number,
  bytes: number,
  log?: Logger,
): Promise<string | null> {
  try {
    return (await executor.readRange(filePath, offset, bytes)).content;
  } catch (err) {
    log?.debug({ err, filePath, offset, bytes }, "file range read failed");
    return null;
  }
}

export async function readTailLines(
  executor: Executor,
  filePath: string,
  maxBytes: number,
  log?: Logger,
): Promise<string[]> {
  const size = await statSizeBytes(executor, filePath, log);
  if (size === null) return [];
  const start = Math.max(0, size - maxBytes);
  const toRead = Math.min(maxBytes, size);
  const content = await readRange(executor, filePath, start, toRead, log);
  if (content === null) return [];
  const lines = content.split("\n").filter((line) => line.length > 0);
  if (start > 0 && lines.length > 0) lines.shift();
  return lines;
}
