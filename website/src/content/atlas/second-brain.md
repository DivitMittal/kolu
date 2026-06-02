---
title: The kolu Atlas
description: kolu's second brain as an in-repo, markdown-authored knowledge base — rendered by Astro, dogfooded in the Code tab.
kind: design
maturity: budding
status: proposed
updated: 2026-06-02
---

> **This doc dogfoods itself.** It's the Atlas design, authored as markdown and
> living *in* the Astro Atlas it describes (`website/src/content/atlas/`),
> rendered by Astro at `/atlas/second-brain`, reviewable in kolu's Code tab.

You already have a second brain — name the roles, don't build a new system.
kolu has two overlapping stores (**GitHub Issues** and in-repo **docs**), a
blog, and an app whose Code tab renders and annotates files. The job is to
assign roles, not add machinery.

## The one routing rule

Route by a single question, stated once and identically everywhere:

> *Is this a **substantial, structured artifact** — or a **lightweight,
> transient node**?*

| Substantial → a **Atlas note** | Lightweight → a **GitHub Issue** |
| --- | --- |
| Plans, designs, research, reviews, retros, history | Bugs, tasks, roadmap items, quick questions |

**Living-vs-frozen is *not* the divider** — a plan tree like `remote-terminals`
lives and evolves for months. Maturity is a per-note **tag**
(`seedling` → `budding` → `evergreen`), never a routing axis and never a
location. The boundary blurs by design: a concept can have both a Atlas note
and a tracking issue. When an issue thread becomes the source of truth,
**extract** its summary into a Atlas note.

## The map — public & Atlas

| Surface | Where | Role |
| --- | --- | --- |
| **Public** | the blog (kolu.dev) + per-release changelog | outward-facing; one post per release |
| **Atlas** | `website/src/content/atlas/` → rendered at `/atlas` | the working brain; markdown notes |

History isn't a third place — it's the Atlas over time (a settled note is just
`evergreen`; git is the history; the changelog is a release artifact).

## Where the Atlas lives: an Astro collection under `website/`

The Atlas is an **Astro content collection** at
`website/src/content/atlas/*.md`, rendered by the existing site and published
at **`kolu.dev/atlas`**. This is the big call, and it earns its keep:

- **Author markdown, get rendered HTML.** One content model with the blog; the
  agents that edit it write plain `.md` + frontmatter.
- **One shared layout + theme** — no per-file CSS (the old HTML notes
  duplicated ~76 KB of it).
- **Generated index, breadcrumbs, backlinks** from frontmatter — see
  *Navigation* below; this retires the hand-curated map *and* its CI gate.
- **A real public site** for free — building in public.
- **`draft: true`** keeps an internal/half-baked note out of the public build
  while it still lives in-repo and stays readable by agents from disk.

> **Spiked 2026-06-02.** This collection + a generated index + a render route
> are live; this very note renders at `/atlas/second-brain` and the build is
> green. The rendered `.html` is committed (marked generated via
> `.gitattributes`) so it's previewable in the Code tab without a dev server —
> an `.apm` rule rebuilds it whenever a Atlas note changes.

## Format — markdown for prose, HTML/SVG for visual artifacts

Author **prose in markdown**; reserve **HTML/SVG** (via MDX/components) only for
genuinely visual or interactive artifacts (diagrams, dashboards). HTML is a
*render target*, not the authored source.

| Why markdown for prose | Evidence |
| --- | --- |
| Far fewer tokens — paid on every agent read | Cloudflare measured ~80% fewer tokens md vs html |
| The CLIs kolu runs prefer it | Claude Code & OpenCode send `Accept: text/markdown` |
| Renders for free where it matters | github.com renders `.md`; the Code tab renders it (#1093) |

> **Honest caveats:** HTML genuinely wins for human-read *output* and visual
> artifacts (Shihipar/Willison). And in-app annotation of *rendered* markdown is
> source-view-only today (#1093 v1) — HTML still annotates the rendered artifact
> directly. Split by regime: markdown for in-repo agent-ingested prose;
> HTML/SVG for visual or one-shot human output.

## Arbitrary HTML, when a note needs it

Prose stays markdown — but when a note needs something markdown can't draw (a
mockup, a diagram, a widget), drop **raw HTML inline** and Astro passes it
straight through. The raw `.md` preview can't render this; the Astro layer can —
which is the whole point. Here's a self-contained HTML + inline-SVG prototype
living in *this very note*:

<div style="font-family:ui-sans-serif,system-ui;max-width:34rem;margin:1.4rem 0;border:1px solid #e6e2d6;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,.06)">
  <div style="display:flex;align-items:center;gap:.5rem;padding:.55rem .85rem;background:#f4f1e8;border-bottom:1px solid #e6e2d6">
    <span style="width:11px;height:11px;border-radius:50%;background:#ff5f56;display:inline-block"></span>
    <span style="width:11px;height:11px;border-radius:50%;background:#ffbd2e;display:inline-block"></span>
    <span style="width:11px;height:11px;border-radius:50%;background:#27c93f;display:inline-block"></span>
    <span style="margin-left:.5rem;font:600 .72rem/1 ui-monospace,monospace;color:#5b6470">atlas / second-brain.html</span>
  </div>
  <div style="padding:1.05rem 1.1rem;background:#fff">
    <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.75rem">
      <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#1b7a3a" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21V11"/><path d="M12 11c0-3.3 2.4-5.8 5.8-5.8 0 3.3-2.4 5.8-5.8 5.8Z"/><path d="M12 14C12 10.7 9.6 8.2 6.2 8.2 6.2 11.5 8.6 14 12 14Z"/></svg>
      <strong style="color:#1a1c20;font-size:.95rem">A note grows up</strong>
    </div>
    <div style="display:flex;align-items:center;gap:.4rem;font:.72rem/1 ui-monospace,monospace">
      <span style="background:#f8efd9;color:#8a5200;border:1px solid #e8d3a3;border-radius:6px;padding:.28rem .55rem">seedling</span>
      <span style="color:#cdb47e">&rarr;</span>
      <span style="background:#dcf0f4;color:#0b6478;border:1px solid #0b6478;border-radius:6px;padding:.28rem .55rem;box-shadow:0 0 0 2px #bfe3ea">budding</span>
      <span style="color:#9fc0c8">&rarr;</span>
      <span style="background:#e3f4e9;color:#1b7a3a;border:1px solid #bce3c8;border-radius:6px;padding:.28rem .55rem">evergreen</span>
    </div>
  </div>
</div>

That frame is a `<div>` + inline `<svg>` with inline styles — no plain-markdown
equivalent. For interactivity (state, scripts), rename the note to `.mdx` and
import a component.


## Navigation — generated, not hand-curated

Astro builds the index from the collection's frontmatter, so **a note can never
be unfiled** — which retires both the hand-curated Map-of-Content *and* the
`docs-moc` CI gate (kept only as long as legacy `docs/plans/*.html` exist).

- **Flat, ancestry-free slugs** — the filename is a handle, not a path.
- The index groups by `kind`, sorts, shows the `maturity` badge, and hides
  drafts in the public build.
- Dead-link checking stays a real, generic invariant (a linter), not a
  bespoke build gate.

## Proposals & decisions — keep the numbered log

A decision/RFC log's value *is* a **stable monotonic identifier** + **append-only
immutability** + supersede links. Don't dissolve it into mutable notes: keep
proposals as **numbered markdown** (`status: proposed → accepted`), which is also
what `CONTRIBUTING.md` already requires. `proposed → accepted` is a *lifecycle*
(a status field), so no separate `docs/decisions/` dir is needed.

## Capture — manual `/atlas retro` first

Three tiers, each in a different home so the always-loaded layer stays lean:

`/be session` → **`/atlas retro` (manual, fresh subagent)** → draft → *accept?* → note → *recurs?* → rule/hook

| Tier | What · where |
| --- | --- |
| ① Ephemeral | the raw transcript (`exportSessionAsHtml.ts`) |
| ② Curated learning | a GitHub Issue, or a `<slug>` Atlas note when rich |
| ③ Durable rule | `.apm/` sources — **graduate must-hold rules to a justci recipe/hook** (memory → rule → code) |

**Start manual, then automate.** Ship a manual `/atlas retro` the maintainer
invokes; it runs as a fresh subagent (same-context self-eval is overconfident),
preserves verbatim vocabulary (error strings, `file:line`), and **drafts** a
note that persists only on accept. Use it ~10×, then consider a gated `/be`
final stage. Promotion ②→③ is human judgment, never an automated counter.

## How the brain feeds releases

A changelog and blog post are the **downstream** of captured history:

`/be session` → `/atlas retro → note` → conventional commit + PR `(#N)` → git-cliff CHANGELOG → `whatchanged → blog` → release

> **Highest-ROI gate of all: a conventional-commit lint on PRs.** Hygiene is
> ~41/100 and the whole release pipeline depends on it. Start warn-only.

## Links — one direction, and the `#N` reality

Links go **one direction** (note → `#N`, note → note) with **no two-way sync**.
But: GitHub does *not* autolink `#N` inside committed files — the real reverse
pointer comes from the **PR/commit that adds the note**. There are no "free
backlinks" from file content.

## Deliberately not building (yet)

A separate `docs/decisions/` or `docs/devlog/` · a seven-kind taxonomy ·
two-way Issue↔docs sync · auto rule-promotion by backlink count ·
auto-capture on every `/be` (until manual proves out) · a decay ritual.

## Rollout

- **Shipped:** the original plans + MOC + house style + the `docs/**` agent rule
  (#1095); the `docs-moc` gate + `plans::check` module (#1098).
- **Now:** the Astro Atlas collection + generated index + render route, with
  committed generated HTML and an auto-rebuild `.apm` rule. This note is the
  first migrated artifact. `release-workflow` was removed.
- **Next:** migrate the remaining `docs/plans/*.html` to Atlas markdown
  on-touch; retire the hand-MOC + `docs-moc` gate as that completes; add the
  conventional-commit lint; ship the first release; then the `/atlas` skill.

## Open

- Maturity tier names settled (`seedling`/`budding`/`evergreen`).
- Committed-generated-HTML churn: marked generated via `.gitattributes`; pages
  are self-contained (inlined styles) so only the touched page changes.
- Conventional-commit lint: warn-only or hard-fail to start?
- Transcript durability: commit exported transcripts, or host out-of-band?

---

*Revised 2026-06-02 after a 7-lane adversarial research pass (format,
navigation, storage, capture, decision-records, comparables, system-shape) with
fact-checking + Hickey/Lowy/completeness critics — which flipped HTML-all-the-way
to markdown-first, kept the numbered proposal log, and dropped a planned rename;
then the Astro direction was chosen for rendering + publishing.*
