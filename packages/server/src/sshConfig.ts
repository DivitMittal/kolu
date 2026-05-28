/** `listSshHosts()` — enumerate ssh-config aliases the user has
 *  defined, for the "New terminal on remote" host picker. Reads
 *  `~/.ssh/config` (plus its `Include` directives) and returns the
 *  static `Host <alias>` entries with their human-readable
 *  `HostName`/`User` annotations when present.
 *
 *  Wildcards (`*`, `?`, `!`) are excluded — those are pattern matchers
 *  for downstream blocks, not target aliases. `Match` blocks are
 *  skipped (they apply conditionally, not as named targets).
 */

import { globSync } from "node:fs";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve as pathResolve } from "node:path";

export interface SshHost {
  /** Alias used as the destination in `ssh <alias>`. */
  alias: string;
  /** Resolved `HostName` from the config (e.g. `100.122.32.106`) if
   *  the entry specifies one. Useful for the picker UI to differentiate
   *  aliases that point at the same host. */
  hostName?: string;
  /** Resolved `User` from the config if specified. */
  user?: string;
}

const HOST_LINE = /^\s*Host\s+(.+?)\s*$/i;
const HOSTNAME_LINE = /^\s*HostName\s+(\S+)/i;
const USER_LINE = /^\s*User\s+(\S+)/i;
const INCLUDE_LINE = /^\s*Include\s+(.+?)\s*$/i;
const MATCH_LINE = /^\s*Match\s+/i;

function expandHome(p: string): string {
  if (p.startsWith("~/")) return pathResolve(homedir(), p.slice(2));
  if (p === "~") return homedir();
  return p;
}

function isWildcard(alias: string): boolean {
  return /[*?!]/.test(alias);
}

/** Parse one ssh-config file, recursively following `Include` lines.
 *  `seen` guards against include cycles. */
function parseFile(path: string, seen: Set<string>): SshHost[] {
  const abs = expandHome(path);
  if (seen.has(abs) || !existsSync(abs)) return [];
  seen.add(abs);

  let contents: string;
  try {
    contents = readFileSync(abs, "utf-8");
  } catch {
    return [];
  }

  const out: SshHost[] = [];
  let currentAliases: string[] = [];
  let inMatch = false;

  for (const raw of contents.split("\n")) {
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (line === "") continue;

    if (MATCH_LINE.test(line)) {
      inMatch = true;
      currentAliases = [];
      continue;
    }

    const incl = INCLUDE_LINE.exec(line);
    if (incl?.[1]) {
      // OpenSSH `Include` accepts (1) multiple whitespace-separated
      // path patterns on one line and (2) glob metacharacters (`*`,
      // `?`, `[...]`) inside each pattern — e.g. `Include
      // ~/.ssh/conf.d/*` is common when an editor like JetBrains or
      // VS Code drops per-project ssh configs. Relative paths are
      // resolved against `~/.ssh/`, absolute paths are honored
      // as-is. Tilde is expanded before globbing because `fs.glob`
      // doesn't understand `~/`.
      const patterns = incl[1].split(/\s+/).filter((p) => p.length > 0);
      for (const pattern of patterns) {
        const absPattern = pattern.startsWith("/")
          ? pattern
          : pathResolve(homedir(), ".ssh", expandHome(pattern));
        const matched = globSync(absPattern);
        // Fall back to literal-path behavior when the pattern has no
        // glob metacharacters (e.g. `Include common`) — `globSync`
        // returns `[absPattern]` if the file exists or `[]` if not,
        // which is the right shape either way.
        for (const target of matched) {
          out.push(...parseFile(target, seen));
        }
      }
      continue;
    }

    const hostMatch = HOST_LINE.exec(line);
    if (hostMatch?.[1]) {
      inMatch = false;
      currentAliases = hostMatch[1]
        .split(/\s+/)
        .filter((a) => a.length > 0 && !isWildcard(a));
      for (const alias of currentAliases) {
        out.push({ alias });
      }
      continue;
    }

    if (inMatch || currentAliases.length === 0) continue;

    const hostName = HOSTNAME_LINE.exec(line)?.[1];
    if (hostName) {
      for (const alias of currentAliases) {
        const entry = out.find((h) => h.alias === alias);
        if (entry && entry.hostName === undefined) entry.hostName = hostName;
      }
      continue;
    }
    const user = USER_LINE.exec(line)?.[1];
    if (user) {
      for (const alias of currentAliases) {
        const entry = out.find((h) => h.alias === alias);
        if (entry && entry.user === undefined) entry.user = user;
      }
    }
  }

  return out;
}

export function listSshHosts(): SshHost[] {
  // Dedupe by alias — multiple Host blocks for the same alias take
  // the first declaration (ssh's own behavior).
  const found = new Map<string, SshHost>();
  for (const host of parseFile("~/.ssh/config", new Set<string>())) {
    if (!found.has(host.alias)) found.set(host.alias, host);
  }
  return [...found.values()].sort((a, b) => a.alias.localeCompare(b.alias));
}
