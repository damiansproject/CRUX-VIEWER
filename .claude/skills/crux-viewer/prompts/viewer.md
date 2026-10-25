# Viewer matching

Quotes are `{ text, locator.page }` from `claims.jsonl`. The viewer searches
the PDF.js text layer (or the live page DOM) with the same fold as
`scripts/lib/match_text.py`: collapse whitespace, keep a hyphen that was
followed by a line break, map ligatures, then a no-space pass and a
hyphen-stripping pass. If the locator page misses, nearby pages are tried.

A miss means the published text does not fold to the stored quote (docling vs
PDF.js, live page changed). Show it on the claim; do not invent a different
span.

Citation markers (numeric `[12]`, author-year `Zou et al., 2023`) are painted
as hover zones (`viewer/citations.mjs` finds their spans; zones stop at the
bibliography). Pointer-enter starts resolution immediately; a 180 ms dwell
opens preview bubbles anchored to the marker — instantly when resolution is
cached, else a shimmer-skeleton card first. Each bubble keeps a skeleton
page until its viewer posts `{crux: "portal-ready"}` after first paint;
cards enter staggered, and a sweep bar runs along the bubble's top while the
model locates the passage. Bubbles are one card per cited paper, side by
side (`/view/<id>#embed=1&q=<citing sentence>&from=…` in iframes; a card's
header opens the full view). Dismissed cards are hidden, never removed —
iframes reload when detached, so a keep-alive pool (cap 6, LRU) keeps each
preview's rendered, landed document alive and re-hovering shows it
instantly.
Right-clicking a selection offers the same via *Open cited paper*. Markers
resolve to catalog papers through the References section by title-token
containment; when that cannot name a paper, `/api/resolve-cite` asks a model
(`lib/locate.py`: `ANTHROPIC_API_KEY`, else the launch host's CLI as for chat,
else the `claude` CLI; `CRUX_LOCATE_MODEL` sets the model for the last). The landing passages are chosen by
`/api/locate` — the model returns up to three verbatim quotes (rules mirror
the claim extractor's: contiguous 1–3 sentence blocks in the paper's own
voice, where the point is established — never a sentence whose job is to
cite other works, and not the abstract/intro unless nothing better exists).
Each quote is re-verified with the same fold-match before painting
`portal-hit` rects; with several passages a find-style pager (bottom pill,
`portal-pager`) steps through them and marks the current one. The
term-overlap heuristic is only the interim landing and the no-model
fallback. Warm-up
makes this seamless: zones on the current page ±1 resolve and pre-locate in
the background (the citing viewer extracts the cited PDF's text itself), the
server memoizes model answers by prompt with in-flight dedup, and a warmed
bubble opens pre-navigated via `#loc` with `#z` carrying the citing page's
scale so the passage renders at the same text size. A miss shows a banner,
never an invented span. A citation whose paper is not in the library gets a
"Get open copy" chip instead: `/api/grab` (`lib/grab.py`) resolves the
bibliography entry to an open-access copy — arXiv id directly, else DOI or
de-hyphenated title via OpenAlex, else the arXiv API — downloads the PDF
through `sources.add_pdf` (landing page via `add_url` as last resort), and
the portal opens on the new row. Entry windows for author-year cites are
trimmed at the closing "…, 2021." boundary and anchored at first-author
occurrences; otherwise windows bleed across entries and mis-match the
catalog.

The side pane has Info, Claims, and Chat. With no claims for a paper the view
opens on Info and the Claims pane shows an empty state — matching is idle,
there is nothing to fold against. Info shows title, gist, identifiers parsed
from the paper, and optional Crossref/arXiv/PubMed fills. Chat posts to
`/api/chat/<paper_id>`; replies are written by the session that launched the
viewer, not by the HTTP server, and the pane shows a typing indicator while
that session is watching and your message is unanswered. Selected source spans
can be attached to the next Chat message. A box mark can save, copy, or attach
a PNG of that region. Typing `/` lists slash commands discovered
from Claude Code or Cursor (skills, workflows, and `.claude` / `.cursor`
command files on that host).

