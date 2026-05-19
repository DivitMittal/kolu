import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HELPER_PROTOCOL_VERSION,
  HelperReadyEventSchema,
} from "kolu-common/helper-protocol";
import { afterEach, describe, expect, it } from "vitest";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const entrypoint = join(packageDir, "src", "index.ts");

const children = new Set<ChildProcessWithoutNullStreams>();

async function stopHelper(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode !== null) return;

  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1_000)),
  ]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

afterEach(async () => {
  await Promise.all([...children].map(stopHelper));
  children.clear();
});

describe("kolu-helper", () => {
  it("announces helper protocol readiness before accepting requests", async () => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", entrypoint, "--serve"],
      {
        cwd: packageDir,
        env: { ...process.env, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    children.add(child);

    const stderr: string[] = [];
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    const lines = createInterface({ input: child.stdout });
    try {
      const line = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(
          () =>
            reject(
              new Error(
                `timed out waiting for helper ready frame: ${stderr.join("")}`,
              ),
            ),
          5_000,
        );
        const fail = (code: number | null, signal: NodeJS.Signals | null) => {
          clearTimeout(timer);
          reject(
            new Error(
              `helper exited before ready frame: code=${code} signal=${signal} stderr=${stderr.join("")}`,
            ),
          );
        };
        child.once("exit", fail);
        lines.once("line", (readyLine) => {
          clearTimeout(timer);
          child.off("exit", fail);
          resolve(readyLine);
        });
      });

      const frame = HelperReadyEventSchema.parse(JSON.parse(line));
      expect(frame.params.protocolVersion).toBe(HELPER_PROTOCOL_VERSION);
      expect(frame.params.version).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      lines.close();
      await stopHelper(child);
      children.delete(child);
    }
  });
});
