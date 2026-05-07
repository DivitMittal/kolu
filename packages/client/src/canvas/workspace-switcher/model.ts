import type { TerminalId } from "kolu-common/surface";
import {
  AGENT_BUCKETS,
  type AgentBucket,
  agentBucket,
  type AgentBucketDescriptor,
} from "../../agent/agentPresentation";
import type { TerminalDisplayInfo } from "../../terminal/terminalDisplay";
import type { TileLayout } from "../TileLayout";
import { repoAccent } from "./identity";

/** Live-terminal source row before a presentation-specific order is applied. */
export interface WorkspaceSwitcherSourceEntry {
  id: TerminalId;
  info: TerminalDisplayInfo;
  layout?: TileLayout;
}

/** Pair terminal ids with display info and optional canvas layout. */
export function buildWorkspaceEntries(
  ids: TerminalId[],
  getDisplayInfo: (id: TerminalId) => TerminalDisplayInfo | undefined,
  getLayout?: (id: TerminalId) => TileLayout | undefined,
): WorkspaceSwitcherSourceEntry[] {
  const entries: WorkspaceSwitcherSourceEntry[] = [];
  for (const id of ids) {
    const info = getDisplayInfo(id);
    if (!info) continue;
    entries.push({ id, info, layout: getLayout?.(id) });
  }
  return entries;
}

/** Order entries by recency descending, with canvas (`x`, `y`) as the
 *  secondary key and stable input order as the final tiebreak. Pure — the
 *  recency value is plugged in via the accessor. The expanded panel
 *  re-buckets by agent state, so the visible effect there is
 *  recency-within-bucket. */
export function sortBySwitcherOrder(
  entries: WorkspaceSwitcherSourceEntry[],
  getRecency: (id: TerminalId) => number,
): WorkspaceSwitcherSourceEntry[] {
  return [...entries].sort((a, b) => {
    const ra = getRecency(a.id);
    const rb = getRecency(b.id);
    if (ra !== rb) return rb - ra;
    const ax = a.layout?.x ?? Infinity;
    const bx = b.layout?.x ?? Infinity;
    if (ax !== bx) return ax - bx;
    const ay = a.layout?.y ?? Infinity;
    const by = b.layout?.y ?? Infinity;
    return ay - by;
  });
}

/** Searchable live-terminal entry used by the expanded switcher panel. */
export type WorkspaceSwitcherEntry = {
  id: TerminalId;
  repoName: string;
  label: string;
  suffix?: string;
  bucket: AgentBucket;
  info: TerminalDisplayInfo;
  searchText: string;
};

/** Compact row item rendered under a repo heading. */
export type WorkspaceSwitcherCompactItem = {
  id: TerminalId;
  label: string;
  suffix?: string;
  info: TerminalDisplayInfo;
};

/** Repo group used by the collapsed desktop switcher and mobile sheet. */
export type WorkspaceSwitcherRepoGroup = {
  repoName: string;
  color: string;
  items: WorkspaceSwitcherCompactItem[];
};

/** Repo facet derived from the current search result set. */
export type WorkspaceRepoFacet = {
  repoName: string;
  count: number;
  color: string;
};

/** Agent bucket plus the entries currently visible in that column. */
export type WorkspaceSwitcherColumn = AgentBucketDescriptor & {
  entries: WorkspaceSwitcherEntry[];
};

/** Complete derived model for collapsed and expanded switcher renderers. */
export type WorkspaceSwitcherModel = {
  entries: WorkspaceSwitcherEntry[];
  compactGroups: WorkspaceSwitcherRepoGroup[];
  visibleEntries: WorkspaceSwitcherEntry[];
  selectedRepo: string | null;
  repoFacets: WorkspaceRepoFacet[];
  columns: WorkspaceSwitcherColumn[];
};

function add(values: string[], value: unknown): void {
  if (value === null || value === undefined) return;
  values.push(String(value));
}

function prSearchFields(info: TerminalDisplayInfo): string[] {
  const pr = info.meta.pr;
  switch (pr.kind) {
    case "ok":
      return [
        pr.kind,
        pr.value.number.toString(),
        pr.value.title,
        pr.value.url,
        pr.value.state,
        pr.value.checks ?? "",
      ];
    case "unavailable":
      return [pr.kind, pr.source.provider, pr.source.code];
    case "absent":
    case "pending":
      return [pr.kind];
  }
}

function searchTextFor(entry: {
  repoName: string;
  label: string;
  suffix?: string;
  info: TerminalDisplayInfo;
}): string {
  const { info } = entry;
  const git = info.meta.git;
  const fg = info.meta.foreground;
  const agent = info.meta.agent;
  const values: string[] = [
    entry.repoName,
    entry.label,
    ...prSearchFields(info),
  ];

  add(values, entry.suffix);
  add(values, info.meta.cwd);
  add(values, info.meta.lastAgentCommand);
  add(values, git?.repoRoot);
  add(values, git?.repoName);
  add(values, git?.worktreePath);
  add(values, git?.branch);
  add(values, git?.mainRepoRoot);
  add(values, fg?.name);
  add(values, fg?.title);
  add(values, agent?.kind);
  add(values, agent?.state);
  add(values, agent?.sessionId);
  add(values, agent?.model);
  add(values, agent?.summary);
  add(values, agent?.contextTokens);
  add(values, agent?.taskProgress?.completed);
  add(values, agent?.taskProgress?.total);

  return values.join(" ").toLowerCase();
}

function queryTokens(query: string): string[] {
  return query.toLowerCase().trim().split(/\s+/).filter(Boolean);
}

function matchesQuery(
  entry: WorkspaceSwitcherEntry,
  tokens: string[],
): boolean {
  return tokens.every((token) => entry.searchText.includes(token));
}

/** Cap on idle (no-agent, non-active) compact pills per repo. Pills that
 *  carry an active agent OR represent the user's active terminal bypass
 *  the cap entirely — both are guaranteed reachable from the pill strip
 *  no matter how many idle peers share the repo. */
const IDLE_PILLS_PER_REPO = 5;

/** Visible-pill count per repo in the collapsed strip. The model uses
 *  this to hoist the active terminal into the visible head when its
 *  natural position would be past the slice boundary, so the renderer
 *  can `slice(0, COMPACT_VISIBLE_PER_REPO)` without re-deriving active
 *  awareness. Single point of enforcement for "active is reachable". */
export const COMPACT_VISIBLE_PER_REPO = 3;

function compactGroupsFor(
  entries: WorkspaceSwitcherEntry[],
  activeId: TerminalId | null,
): WorkspaceSwitcherRepoGroup[] {
  const groups = new Map<string, WorkspaceSwitcherRepoGroup>();
  const idleCounts = new Map<string, number>();
  for (const entry of entries) {
    let group = groups.get(entry.repoName);
    if (!group) {
      group = {
        repoName: entry.repoName,
        color: repoAccent(entry.info),
        items: [],
      };
      groups.set(entry.repoName, group);
    }
    // Idle-cap bypass: in-flight agent (salience) or active terminal
    // (reachability). Names kept so a future divergence stays visible.
    const hasAgent = entry.info.meta.agent !== null;
    const isFocused = entry.id === activeId;
    if (!hasAgent && !isFocused) {
      const idle = idleCounts.get(entry.repoName) ?? 0;
      if (idle >= IDLE_PILLS_PER_REPO) continue;
      idleCounts.set(entry.repoName, idle + 1);
    }
    group.items.push({
      id: entry.id,
      label: entry.label,
      suffix: entry.suffix,
      info: entry.info,
    });
  }
  // Hoist active into the visible prefix so `Collapsed.tsx`'s
  // `slice(0, N)` cannot clip a focused-but-not-recent terminal into
  // the `+N` overflow chip.
  if (activeId !== null) {
    for (const group of groups.values()) {
      const idx = group.items.findIndex((item) => item.id === activeId);
      if (idx >= COMPACT_VISIBLE_PER_REPO) {
        // biome-ignore lint/style/noNonNullAssertion: idx came from findIndex on the same array, splice always yields the element.
        const active = group.items.splice(idx, 1)[0]!;
        group.items.splice(COMPACT_VISIBLE_PER_REPO - 1, 0, active);
      }
    }
  }
  // Stable repo slot via alphabetical; intra-repo recency comes from
  // input order (set upstream by `sortBySwitcherOrder`).
  return [...groups.values()].sort((a, b) =>
    a.repoName.localeCompare(b.repoName),
  );
}

/** Derive all switcher projections (search, facets, bucket columns,
 *  compact groups) from one live-terminal entry list. Owns the ordering
 *  pipeline — when `getRecency` is provided, applies `sortBySwitcherOrder`
 *  internally so callers can't feed unsorted entries into the grouping. */
export function buildWorkspaceSwitcherModel(
  sources: WorkspaceSwitcherSourceEntry[],
  options: {
    query?: string;
    repoFilter?: string | null;
    activeId?: TerminalId | null;
    getRecency?: (id: TerminalId) => number;
  } = {},
): WorkspaceSwitcherModel {
  const ordered = options.getRecency
    ? sortBySwitcherOrder(sources, options.getRecency)
    : sources;
  const entries: WorkspaceSwitcherEntry[] = ordered.map((source) => {
    const base = {
      id: source.id,
      repoName: source.info.key.group,
      label: source.info.key.label,
      suffix: source.info.key.suffix,
      bucket: agentBucket(source.info.meta.agent),
      info: source.info,
    };
    return {
      ...base,
      searchText: searchTextFor(base),
    };
  });

  const { repoFacets, selectedRepo, visibleEntries } = searchResults(
    entries,
    options.query ?? "",
    options.repoFilter ?? null,
  );

  const columns = AGENT_BUCKETS.map((bucket) => ({
    ...bucket,
    entries: visibleEntries.filter((entry) => entry.bucket === bucket.key),
  }));

  return {
    entries,
    compactGroups: compactGroupsFor(entries, options.activeId ?? null),
    visibleEntries,
    selectedRepo,
    repoFacets,
    columns,
  };
}

/** Filter, facet, and repo-narrow in one shot. Bundling the three
 *  results makes the dependency explicit: facets count *pre*-repo-
 *  filter matches (so the user can see how many entries would appear
 *  in each repo), `visibleEntries` count *post*-filter (only the
 *  selected repo). Splitting them across separate locals invited a
 *  silent reordering bug. */
function searchResults(
  entries: WorkspaceSwitcherEntry[],
  query: string,
  repoFilter: string | null,
): {
  repoFacets: WorkspaceRepoFacet[];
  selectedRepo: string | null;
  visibleEntries: WorkspaceSwitcherEntry[];
} {
  const tokens = queryTokens(query);
  const queryMatches =
    tokens.length === 0
      ? entries
      : entries.filter((entry) => matchesQuery(entry, tokens));

  const facetCounts = new Map<string, { count: number; color: string }>();
  for (const entry of queryMatches) {
    const facet = facetCounts.get(entry.repoName);
    if (facet) {
      facet.count += 1;
    } else {
      facetCounts.set(entry.repoName, {
        count: 1,
        color: repoAccent(entry.info),
      });
    }
  }
  const repoFacets = [...facetCounts.entries()].map(
    ([repoName, { count, color }]) => ({
      repoName,
      count,
      color,
    }),
  );

  const selectedRepo =
    repoFilter && facetCounts.has(repoFilter) ? repoFilter : null;
  const visibleEntries = selectedRepo
    ? queryMatches.filter((entry) => entry.repoName === selectedRepo)
    : queryMatches;

  return { repoFacets, selectedRepo, visibleEntries };
}
