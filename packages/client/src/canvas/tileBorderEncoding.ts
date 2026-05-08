/** Canvas tile border encoding — names the policy for combining the
 *  three signals the tile carries: agent state, focus, and idle baseline.
 *
 *    Outer ring  → agent state via `pill-border-{awaiting,working}`
 *                  (single source of truth: `bucketDescriptor`).
 *    Inset glow  → active focus via `pill-glow-inner` driven by
 *                  `--card-color` (per-terminal repo accent).
 *    Edge tint   → idle baseline (`border-edge/40`) for tiles with
 *                  no bucket signal — independent of the chassis so
 *                  the tile stays legible when no agent is present.
 *
 *  The two coloured channels coexist when both are present — outer
 *  carries bucket, inset carries identity, so an active+working tile
 *  shows a steady accent ring around a brighter inset rim. Maximized
 *  drops both: edge-to-edge fill, no border at all. */

import type { AgentBucket } from "../agent/agentPresentation";

export type TileBorderEncoding = {
  /** SolidJS classList map — spread into the tile's `classList` prop.
   *  Returning a map (rather than a string for `class={…}`) is mandatory:
   *  combining a reactive `class` template with a reactive `classList`
   *  on the same element loses every `classList` entry when the
   *  template re-runs, which previously stripped `absolute`/`rounded-xl`
   *  off the tile and left it in document flow. */
  classList: Record<string, boolean>;
  style: Record<string, string>;
};

/** Two channels, both expressed through the `tile-ring` chassis:
 *  bucket → ring colour, focus → ring thickness. Every tile gets a
 *  ring (no neutral fallback) — idle tiles paint `--card-color` at
 *  60% / 100% intensity, bucket tiles paint accent / alert at 70% /
 *  95%. Thickness steps 1px → 2px → 3px so the active tile in any
 *  bucket stays distinguishable from inactive peers without inventing
 *  a third channel. Awaiting layers a breath animation on top — the
 *  only animated state. */
function tileRingColor(args: { active: boolean; bucket: AgentBucket }): string {
  if (args.bucket === "none") {
    const intensity = args.active ? "100%" : "60%";
    return `color-mix(in oklch, var(--card-color) ${intensity}, transparent)`;
  }
  const base =
    args.bucket === "working" ? "var(--color-accent)" : "var(--color-alert)";
  const intensity = args.active ? "95%" : "70%";
  return `color-mix(in oklch, ${base} ${intensity}, transparent)`;
}

function tileRingThickness(args: {
  active: boolean;
  bucket: AgentBucket;
}): string {
  if (args.bucket === "none") return args.active ? "2px" : "1px";
  return args.active ? "3px" : "2px";
}

export function tileBorderEncoding(args: {
  active: boolean;
  maximized: boolean;
  bucket: AgentBucket;
  cardColor: string;
}): TileBorderEncoding {
  const style: Record<string, string> = { "--card-color": args.cardColor };
  if (args.maximized) {
    // Maximized fills the viewport edge-to-edge — no ring, no body
    // border. Caller still needs the layout positioning classes.
    return { classList: {}, style };
  }
  style["--tile-ring-color"] = tileRingColor(args);
  style["--tile-ring-thickness"] = tileRingThickness(args);
  return {
    classList: {
      "tile-ring": true,
      "tile-ring--active": args.active,
      "tile-ring--breath": args.bucket === "awaiting",
    },
    style,
  };
}
