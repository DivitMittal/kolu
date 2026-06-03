import type { CollectionEntry } from "astro:content";

export interface TreeNode {
  note: CollectionEntry<"atlas">;
  children: TreeNode[];
}

/** Build a parent→children forest from flat notes. `data.parent` is a note id
 *  (flat slug); a note whose parent is missing, self, or filtered out (e.g. a
 *  draft) becomes a root — so nothing is ever unfiled. Cycle-safe: any node not
 *  reachable from a root is promoted to a root rather than lost. Children keep
 *  the incoming order (sort `notes` before calling); roots are title-sorted. */
export function buildNoteTree(notes: CollectionEntry<"atlas">[]): TreeNode[] {
  const nodes = new Map<string, TreeNode>(
    notes.map((n) => [n.id, { note: n, children: [] }]),
  );
  const roots: TreeNode[] = [];
  for (const n of notes) {
    const node = nodes.get(n.id)!;
    const parentId = n.data.parent;
    const parent =
      parentId && parentId !== n.id ? nodes.get(parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }

  // Promote any note unreachable from a root (a parent cycle) so it still shows.
  const seen = new Set<string>();
  const walk = (ns: TreeNode[]): void => {
    for (const x of ns) {
      if (seen.has(x.note.id)) continue;
      seen.add(x.note.id);
      walk(x.children);
    }
  };
  walk(roots);
  for (const n of notes) {
    if (!seen.has(n.id)) roots.push(nodes.get(n.id)!);
  }

  roots.sort((a, b) => a.note.data.title.localeCompare(b.note.data.title));
  return roots;
}
