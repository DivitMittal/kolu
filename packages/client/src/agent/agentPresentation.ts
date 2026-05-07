/** Agent-state visual encoding — single source of truth.
 *
 *  Three buckets (`awaiting` / `working` / `none`) drive the visual
 *  vocabulary used wherever Kolu surfaces agent activity: the workspace
 *  switcher (compact pills + expanded cards), the canvas tile, and the
 *  minimap. Co-located here so adding a fourth bucket or re-skinning an
 *  existing one is a one-file edit; presentation surfaces consume the
 *  descriptor rather than re-deriving the same mapping in each component.
 *
 *  CSS chassis lives in `index.css` (`pill-border-*`, `pill-glow-inner`);
 *  this module names the buckets and supplies the variables that drive it.
 *  Surface-specific suppressions (e.g. minimap drops animation in favour of
 *  a static colour) are also exposed here so the variant doesn't accumulate
 *  inline at the call site. */
import type { AgentInfo } from "kolu-common/surface";

export type AgentBucket = "awaiting" | "working" | "none";

export type AgentBucketDescriptor = {
  key: AgentBucket;
  label: string;
  empty: string;
  textClass: string;
  accentVar: string;
  borderClass: string;
  glyph: string;
};

export const AGENT_BUCKETS: readonly AgentBucketDescriptor[] = [
  {
    key: "awaiting",
    label: "Awaiting you",
    empty: "No terminals need input",
    textClass: "text-alert",
    accentVar: "var(--color-alert)",
    borderClass: "pill-border pill-border-awaiting",
    glyph: "⏵",
  },
  {
    key: "working",
    label: "Working",
    empty: "No agents are running",
    textClass: "text-accent",
    accentVar: "var(--color-accent)",
    borderClass: "pill-border pill-border-working",
    glyph: "▸",
  },
  {
    key: "none",
    label: "No agent",
    empty: "No plain shells match",
    textClass: "text-fg-3",
    accentVar: "var(--color-fg-3)",
    borderClass: "",
    glyph: "·",
  },
];

const BY_KEY: Record<AgentBucket, AgentBucketDescriptor> = AGENT_BUCKETS.reduce(
  (acc, bucket) => {
    acc[bucket.key] = bucket;
    return acc;
  },
  {} as Record<AgentBucket, AgentBucketDescriptor>,
);

/** Classify live agent metadata into the fixed bucket set. */
export function agentBucket(agent: AgentInfo | null | undefined): AgentBucket {
  switch (agent?.state) {
    case "waiting":
      return "awaiting";
    case "thinking":
    case "tool_use":
      return "working";
    case undefined:
      return "none";
  }
}

/** Look up a descriptor by its key. */
export function bucketDescriptor(bucket: AgentBucket): AgentBucketDescriptor {
  return BY_KEY[bucket];
}

/** Bucket colour used by surfaces that paint a static border instead of
 *  the animated `pill-border-*` chassis — the minimap drops animation
 *  because at minimap scale a 1.6s breathing ring is jittery and burns
 *  paint. Naming the suppression here keeps the partially-applied lookup
 *  out of the call site. */
export function tileMinimapColor(bucket: AgentBucket): string {
  return bucketDescriptor(bucket).accentVar;
}
