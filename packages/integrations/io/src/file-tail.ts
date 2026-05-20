import type { Logger } from "kolu-shared";
import type { Executor } from "./executor.ts";
import { isNotFoundError } from "./errors.ts";

type OptionalIo<T> =
  | { kind: "ok"; value: T }
  | { kind: "absent" }
  | { kind: "error"; error: unknown };

async function tryStatSizeBytes(
  executor: Executor,
  filePath: string,
  log?: Logger,
): Promise<OptionalIo<number>> {
  try {
    return { kind: "ok", value: await executor.statSizeBytes(filePath) };
  } catch (err) {
    if (isNotFoundError(err)) {
      log?.debug({ filePath }, "file size query skipped: file absent");
      return { kind: "absent" };
    }
    log?.error({ err, filePath }, "file size query failed");
    return { kind: "error", error: err };
  }
}

async function tryReadRange(
  executor: Executor,
  filePath: string,
  offset: number,
  bytes: number,
  log?: Logger,
): Promise<OptionalIo<string>> {
  try {
    return {
      kind: "ok",
      value: (await executor.readRange(filePath, offset, bytes)).content,
    };
  } catch (err) {
    if (isNotFoundError(err)) {
      log?.debug(
        { filePath, offset, bytes },
        "file range read skipped: file absent",
      );
      return { kind: "absent" };
    }
    log?.error({ err, filePath, offset, bytes }, "file range read failed");
    return { kind: "error", error: err };
  }
}

export async function statSizeBytes(
  executor: Executor,
  filePath: string,
  log?: Logger,
): Promise<number | null> {
  const result = await tryStatSizeBytes(executor, filePath, log);
  if (result.kind === "ok") return result.value;
  if (result.kind === "absent") return null;
  throw result.error;
}

export async function readRange(
  executor: Executor,
  filePath: string,
  offset: number,
  bytes: number,
  log?: Logger,
): Promise<string | null> {
  const result = await tryReadRange(executor, filePath, offset, bytes, log);
  if (result.kind === "ok") return result.value;
  if (result.kind === "absent") return null;
  throw result.error;
}

export async function readTailLines(
  executor: Executor,
  filePath: string,
  maxBytes: number,
  log?: Logger,
): Promise<string[] | null> {
  const sizeResult = await tryStatSizeBytes(executor, filePath, log);
  if (sizeResult.kind === "absent") return [];
  if (sizeResult.kind === "error") return null;
  const size = sizeResult.value;
  const start = Math.max(0, size - maxBytes);
  const toRead = Math.min(maxBytes, size);
  const contentResult = await tryReadRange(
    executor,
    filePath,
    start,
    toRead,
    log,
  );
  if (contentResult.kind === "absent") return [];
  if (contentResult.kind === "error") return null;
  const content = contentResult.value;
  const lines = content.split("\n").filter((line) => line.length > 0);
  if (start > 0 && lines.length > 0) lines.shift();
  return lines;
}
