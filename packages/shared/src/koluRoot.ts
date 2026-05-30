/**
 * Per-process temp root for process-generated files.
 *
 * Both kolu-server and the `kolu --stdio` PTY-host daemon write shell rc files
 * and per-terminal scratch storage (clipboard image pastes, drag-and-drop file
 * drops) under a single root keyed by THIS process's startup UUID, rooted at
 * `$XDG_RUNTIME_DIR` when available. Each process gets its own root (its own
 * UUID), so the daemon and server never collide — and since #951 R4c the daemon
 * spawns the shells, so it owns its koluRoot's rc files.
 *
 * Lives in `kolu-shared` (zero deps) so the daemon (`@kolu/pty-host`) can write
 * its shell rc files without importing kolu-server (which would be a cycle).
 *
 * Privacy: `$XDG_RUNTIME_DIR` on Linux is /run/user/$UID — tmpfs, mode 0700,
 * wiped at logout. Scratch files can contain screenshots, dropped files,
 * and secrets; sharing /tmp with every other user on the host was the
 * wrong default. macOS os.tmpdir() already returns a per-user dir.
 * Non-systemd Linux falls back to /tmp with no regression.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const runtimeRoot = process.env.XDG_RUNTIME_DIR ?? tmpdir();

/** This process's startup UUID — changes on every restart. */
const processId = randomUUID();

/** Per-process root. Everything kolu writes to disk for transient
 *  per-terminal use lives under here. */
export const koluRoot = join(runtimeRoot, `kolu-${processId}`);

/** Injected bash rc files and zsh ZDOTDIRs, one pair per spawned terminal. */
export const koluShellDir = join(koluRoot, "shell");

/** Per-terminal scratch directories where clipboard image pastes and
 *  drag-and-drop file drops land on disk. */
export const koluScratchDir = join(koluRoot, "scratch");

/** Create the root + subdirs with owner-only mode. Called once at process
 *  startup before any terminal spawns. Idempotent. */
export function ensureKoluRoot(): void {
  mkdirSync(koluShellDir, { recursive: true, mode: 0o700 });
  mkdirSync(koluScratchDir, { recursive: true, mode: 0o700 });
}

/** Remove the whole per-process root on shutdown. Registered on the
 *  `process.on('exit', ...)` hook so it runs synchronously from every exit
 *  path. If rmSync throws, Node's default exit-handler reporter prints the
 *  stack — we do not swallow. */
export function shutdownCleanup(): void {
  rmSync(koluRoot, { recursive: true, force: true });
}
