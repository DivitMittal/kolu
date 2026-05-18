/**
 * `~/.ssh/config` parser — enumerate the `Host` aliases the user has
 * configured so Kolu's "New terminal" picker can list them.
 *
 * The OpenSSH config grammar is rich; we implement the slice that
 * matters for enumeration:
 *
 *   - `Host <alias> [<alias>…]` — emit one entry per non-wildcard alias.
 *   - `HostName` / `User` / `Port` — attach to the most recent Host.
 *   - `Include <pattern>` — glob and recurse (supports `~/`, absolute
 *     paths, and paths relative to the including file's directory,
 *     matching OpenSSH semantics).
 *
 * Anything else (Match blocks, wildcards, ProxyCommand, IdentityFile,
 * …) is silently ignored. Wildcard hosts (`Host *`, `Host *.foo`) are
 * excluded from the picker — they're config templates, not destinations.
 *
 * Recursion depth is bounded so a self-including config can't lock the
 * picker up at startup.
 */

import { globSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

export interface SshHostEntry {
  /** The alias (the value after `Host`). Used as the stable hostId in
   *  TerminalCreateInput and saved sessions. Must be unique. */
  alias: string;
  /** Resolved hostname (from `HostName`, or the alias if absent). */
  hostname: string;
  /** SSH user, if explicitly configured. */
  user?: string;
  /** SSH port, if explicitly configured. */
  port?: number;
}

interface ParseCtx {
  /** Absolute path of the file currently being parsed — used to resolve
   *  relative `Include` paths the way OpenSSH does. */
  filePath: string;
  /** Number of Include hops walked so far. Bounded to prevent cycles. */
  depth: number;
  /** Files already opened in this parse — short-circuits include cycles
   *  even when the user has a legitimately-circular include graph. */
  visited: Set<string>;
}

const MAX_INCLUDE_DEPTH = 8;

/** Expand a single `Include` argument into the list of files it resolves
 *  to. `~/` is replaced with the user's homedir; relative paths resolve
 *  against the *including* file's directory (OpenSSH does this since
 *  2010; before that they were relative to `~/.ssh/`). Globs (`*`, `?`)
 *  are expanded; literal paths are returned as-is. */
function resolveIncludePaths(arg: string, ctx: ParseCtx): string[] {
  const expanded = arg.startsWith("~/")
    ? join(homedir(), arg.slice(2))
    : isAbsolute(arg)
      ? arg
      : resolve(dirname(ctx.filePath), arg);
  // node 22's fs.globSync returns the list of matches, or an empty list
  // if the pattern matches nothing. Wrap defensively — globSync on a
  // literal path (no glob chars) still works and returns [path] if it
  // exists, [] otherwise.
  try {
    const matches = globSync(expanded);
    return matches.length > 0 ? matches : [];
  } catch {
    return [];
  }
}

function parseInto(
  content: string,
  ctx: ParseCtx,
  entries: SshHostEntry[],
): void {
  let current: SshHostEntry | null = null;

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;

    // OpenSSH allows `Key Value` or `Key=Value`. Constrain the key to
    // alphabetic-prefixed identifiers so the value can't bleed back into
    // the key via the regex's greedy `\S+`.
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*=?\s*(.*)$/);
    if (!match) continue;
    const key = match[1]?.toLowerCase();
    const value = match[2]?.trim() ?? "";
    if (!key) continue;

    if (key === "include") {
      // Push `current` before recursing — the included file may declare
      // its own Host blocks and we want those interleaved correctly.
      if (current) {
        entries.push(current);
        current = null;
      }
      if (ctx.depth >= MAX_INCLUDE_DEPTH) continue;
      for (const includedPath of resolveIncludePaths(value, ctx)) {
        if (ctx.visited.has(includedPath)) continue;
        ctx.visited.add(includedPath);
        try {
          const included = readFileSync(includedPath, "utf8");
          parseInto(
            included,
            {
              filePath: includedPath,
              depth: ctx.depth + 1,
              visited: ctx.visited,
            },
            entries,
          );
        } catch {
          // Unreadable include — silently skip, mirroring OpenSSH which
          // tolerates missing include targets without aborting.
        }
      }
      continue;
    }

    if (key === "host") {
      if (current) entries.push(current);
      current = null;
      const aliases = value
        .split(/\s+/)
        .filter((a) => a.length > 0 && !/[*?!]/.test(a));
      if (aliases.length === 0) continue;
      const lastAlias = aliases[aliases.length - 1];
      if (!lastAlias) continue;
      // Leading aliases land with bare defaults; the trailing alias
      // accumulates the body keys (HostName/User/Port) below.
      for (const alias of aliases.slice(0, -1)) {
        entries.push({ alias, hostname: alias });
      }
      current = { alias: lastAlias, hostname: lastAlias };
      continue;
    }

    if (!current) continue;
    if (key === "hostname") current.hostname = value;
    else if (key === "user") current.user = value;
    else if (key === "port") {
      const parsed = Number.parseInt(value, 10);
      if (Number.isFinite(parsed) && parsed > 0) current.port = parsed;
    }
  }

  if (current) entries.push(current);
}

/** Parse the content of an SSH config file. Top-level entry point used
 *  by tests; for production reads, prefer `readSshHosts()` which handles
 *  the path resolution and `Include` recursion against the file system. */
export function parseSshConfig(
  content: string,
  filePath?: string,
): SshHostEntry[] {
  const entries: SshHostEntry[] = [];
  parseInto(
    content,
    {
      filePath: filePath ?? join(homedir(), ".ssh", "config"),
      depth: 0,
      visited: new Set(),
    },
    entries,
  );
  return entries;
}

/** Read and parse `~/.ssh/config`, following `Include` directives. Returns
 *  an empty list if the file doesn't exist or can't be read — the picker
 *  degrades to "Local only" without surfacing a missing-file error. */
export function readSshHosts(): SshHostEntry[] {
  const path = join(homedir(), ".ssh", "config");
  try {
    const content = readFileSync(path, "utf8");
    return parseSshConfig(content, path);
  } catch {
    return [];
  }
}
