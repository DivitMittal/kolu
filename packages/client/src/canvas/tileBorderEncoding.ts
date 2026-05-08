/** Canvas tile border encoding.
 *
 *  The tile-ring is a single channel that encodes BUCKET + IDENTITY
 *  (not focus): every tile gets a ring whose colour and thickness
 *  depend only on its agent bucket. Idle tiles paint `--card-color`
 *  (per-terminal repo accent) at 1px; bucket tiles paint accent /
 *  alert at 2px. Active vs inactive is signalled separately via
 *  drop shadow + opacity + z-index — the ring does not change with
 *  focus. Maximized drops the ring (edge-to-edge fill). */

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

/** The `tile-ring` chassis paints one ring per tile — colour from
 *  bucket, thickness from bucket alone (NOT focus). Active vs inactive
 *  is signalled outside the ring entirely (drop shadow + opacity +
 *  z-index in `tileStyle`); the ring stays constant so the user sees
 *  identity/state, not focus, on the border channel. */
function tileRingColor(bucket: AgentBucket): string {
  if (bucket === "none") return "var(--card-color)";
  const base =
    bucket === "working" ? "var(--color-accent)" : "var(--color-alert)";
  return `color-mix(in oklch, ${base} 80%, transparent)`;
}

function tileRingThickness(bucket: AgentBucket): string {
  return bucket === "none" ? "1px" : "2px";
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
  style["--tile-ring-color"] = tileRingColor(args.bucket);
  style["--tile-ring-thickness"] = tileRingThickness(args.bucket);
  return {
    classList: {
      "tile-ring": true,
      "tile-ring--breath": args.bucket === "awaiting",
    },
    style,
  };
}
