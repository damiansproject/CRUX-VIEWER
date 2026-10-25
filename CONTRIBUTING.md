# Contributing

Thanks for looking at CRUX Viewer. It is deliberately small: a
small Python server (one pinned dependency, pypdf) plus vanilla JS modules, no build step,
no npm install.

## Layout

```
.claude/skills/crux-viewer/
  scripts/serve_literature.py   HTTP server, all routes
  scripts/lib/                  server-side modules (catalog, marks, chat,
                                locate = model calls, grab = open-access fetch)
  scripts/viewer/               the browser app: view.js + small .mjs modules
  prompts/viewer.md             how matching and citation portals work
tests/                          pytest suites + node:test suites (*.mjs)
```

Pure logic lives in importable modules (`viewer/*.mjs`, `lib/*.py`) so both
runtimes can test it without a browser; `view.js` should stay a thin layer of
DOM wiring over those modules.

## Running tests

```bash
pip install -e ".[test]"
pytest            # runs the Python suites and every node --test suite
```

Node 20+ is needed for the `.mjs` suites (they are skipped if `node` is
missing). To run one directly: `node --test tests/test_citations.mjs`.
The real-browser suite is opt-in: `pip install playwright pillow`, `playwright install chromium`,
and set `CRUX_BROWSER_ASSETS` to a folder holding `pdf.min.js`, `pdf.worker.min.js` (PDF.js 3.11.174)
and `markdown-it.min.js` (14.1.0); `CRUX_CLAIMS_ROOT` points one case at an installed claim-extractor.

## Ground rules

- The server binds `127.0.0.1`, answers only its own pages (no CORS), and keeps to
  the pinned dependencies in `pyproject.toml`.
- Model calls (`lib/locate.py`) must degrade gracefully: no API key and no
  signed-in CLI means heuristics only, never an error page.
- Anything a model returns is verified against the source text before it is
  shown; a miss shows a banner, never an invented span.
- New pure logic gets a test in the matching runtime; behavior that spans
  both (like text folding in `match.js` / `lib/match_text.py`) must change in
  lockstep on both sides.
