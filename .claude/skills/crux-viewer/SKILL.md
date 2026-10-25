---
name: crux-viewer
description: >-
  CRUX Viewer: open original PDFs and live web sources in the browser,
  either tracing a run’s extracted claim quotes highlighted on the published
  page, or reading any folder of PDFs standalone with no claims. Use when
  opening source documents to read them — not the literature-map tool, not
  skim HTML reports, not extraction or the hypothesis loop. At start ask for
  the run directory or the folder of PDFs if it is missing from chat.
---

# CRUX Viewer

Open original sources with quoted claim spans painted on the published page.
Opening the reader does not convert, extract, generate, rank, or write skim reports. This is not
the literature-map tool (`literature_map.json` / `literature_map.html`).

Depends only on the PDFs / URLs themselves, plus a run’s `claims.jsonl` when
there is one to highlight. Do not invoke this skill from `/crux-claims`
or `/crux`.

Human how-to: [../../../README.md](../../../README.md).

## Kickoff (always, this skill)

At the **start** of this skill — before starting the viewer — collect what is
still missing. Skip any item the user already gave in chat.

1. **Run directory or a folder of PDFs**, if missing. A run is a folder that
   contains `claims.jsonl` (usually `.crux_run/<name>/`); a plain folder of
   PDFs is equally valid.
2. **Paper**, if missing and the user named one. Otherwise the picker lists
   every source that has claims, plus PDFs and sites added from the picker.

If there is no `claims.jsonl`, do not stop and do not extract here — point
`--sources` at the folder of PDFs instead. Claim highlighting needs
`/crux-claims` from CRUX-CLAIMS run first; everything else works without
it.

## Runtime

`<skill_root>` = `${CLAUDE_PLUGIN_ROOT}/.claude/skills/crux-viewer`
(plugin/Cowork) or `.claude/skills/crux-viewer` (this repo).

No slash workflows. The product is a local viewer on `127.0.0.1`.

**With Claude Code Channels enabled**, use the plugin's `open_viewer` tool
with `run` or `sources` and the session's `model`/`effort`, then give the user its URL. It starts the reader in
this session; do not also start the script below. Custom channels currently
require `--dangerously-load-development-channels plugin:crux-viewer@<marketplace>`
at Claude Code startup ([channel setup](https://code.claude.com/docs/en/channels-reference#test-during-the-research-preview)).
On a channel event, call `read_chat` once and answer with `reply`, using the
returned message ID as `in_reply_to`. Return to idle after replying.

**Without a channel**, start the server in the background (do not block
the session waiting on the HTTP process):

```
python <skill_root>/scripts/serve_literature.py --run <run> --host <codex|cursor|claude> --model <session-model>
```

For a bare folder of PDFs — no run, no claims — use `--sources` instead:

```
python <skill_root>/scripts/serve_literature.py --sources <folder> --host <codex|cursor|claude> --model <session-model>
```

It scans top-level `*.pdf`, scaffolds `<folder>/.crux-viewer/` (or `--run`’s
value if you pass one) with an empty `claims.jsonl` and a
`literature_sources.json` naming those PDFs where they sit, then serves them.
Re-running on the same folder is idempotent.

Optional: `--paper <paper_id>` skips the picker; `--port 8765`; `--no-open`
if you will print the URL yourself.

Then tell the user the URL (script prints `CRUX Viewer  http://127.0.0.1:…`).

**Attach the listener at launch.** The standalone server automatically watches
`<run>/literature_chat/<paper_id>.jsonl` and answers through a separate worker
using the launching host and exact model. Pass the host/model explicitly, and
`--effort` when available; do not assume another provider or downgrade tiers.
For Cursor, use its model ID including effort suffix or parameters. Confirm
`/api/chat/_workspace` reports `watching: true` and the expected agent/model
before saying chat is connected. Setup failures appear in `error`.

The worker receives the saved Viewer conversation, selected source text, spans,
and image files. It does not inherit the coding session's private conversation.
Only saved messages invoke a model; idle listening uses no model calls. Messages
arriving during a reply stay queued. On a failed reply, fix the displayed issue
and send again. The server must stay running for this automatic round trip.

Claude's native channel continues to answer in the launching session. Do not
start a second listener for a channel-owned Viewer. For manual inspection:

```
python <skill_root>/scripts/watch_chat.py --run <run> --once
```

`--once` prints `{ pending, watching }` JSON. `attachments`
are spans or box images the user selected in the viewer — treat them like a
VS Code selection. Image attachments have a `file` path under the run
directory; open that PNG.

The pane shows responding after you pick up a pending message.

Keep replies short — this is a chat pane beside the paper, not a report.
A few sentences, lead with the answer, quote the source instead of
paraphrasing at length. Only go long when the user asks for depth. Use `reply`
with the channel, or this command for a manual mailbox reply:

```
python <skill_root>/scripts/watch_chat.py --run <run> --reply <paper_id> --text "…" --in-reply-to <message_id>
```

Queued messages remain saved until a worker or native channel answers them.

## Claim extraction

Uploading a PDF through the Library picker or retrieving an open copy queues extraction if that source has
no banked claims. Imports run one at a time through the same host/model-matched
worker, including multi-file uploads. Opening an existing paper or a standalone
folder does not start extraction. Failed extraction keeps the imported PDF;
the Claims pane shows the setup or worker error and offers a retry.

The Claims pane has **Extract claims** / **Re-extract claims** for the open
original PDF. Clicking it runs a separate host/model-matched worker through the installed
CRUX Claims prompt and writer; it does not use Viewer chat or require a
listener. Outside the PDF import action, do not launch extraction merely
because a paper has no claims.
The button reports progress, setup errors, model limits, and quote-validation
failures. Existing claims remain until the result is verified and published;
re-extraction replaces only that source's rows, with new IDs and a saved prior
bank. The reader refreshes the claims and highlights when the worker finishes.
See README's Model access section for installation and configuration.

## Who does what

| Role | Responsibility |
| --- | --- |
| **Main (you)** | Open the reader with the launching host/model; verify the listener; give the URL; answer native channel events when using Claude Channels |
| **Provided scripts** | Local viewer: PDF.js for PDFs, live re-fetch + proxy for web, quote matching, Info/Chat APIs |
| **Not bundled** | CRUX Claims prompt/writer (install separately for the extraction button), literature-map, reports, hypothesis loop |

## Invariants

- Read `claims.jsonl` and `cleaned_jsons/index.json`. Writes are
  `<run>/literature_marks/<paper_id>.json` (user highlighter / box / underline),
  `<run>/literature_meta/<paper_id>.json` (Info overlay),
  `<run>/literature_chat/<paper_id>.jsonl` (Chat mailbox),
  `<run>/literature_chat/<paper_id>_files/` (attached box images),
  `<run>/literature_chat/workers/` (automatic reply logs),
  and sources added from the picker (`literature_sources.json`, PDFs in
  `literature_inbox/`). `--sources` additionally scaffolds the run dir itself
  — `<folder>/.crux-viewer/` with an empty `claims.jsonl` and
  `literature_sources.json` — and the PDFs stay where they are.
- Do not invent quotes. Unmatched spans stay listed as missed.
- Web pages are re-fetched live (no publisher cookies — paywalls may show login).
- Bind localhost only.
