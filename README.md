# CRUX Viewer

A local browser for original PDFs and web pages that integrates CRUX's capabilities.
For example, it can highlight claims extracted by [CRUX Claims](https://github.com/damiansproject/CRUX-CLAIMS), and integrate it into the PDF viewer. Furthermore, you can also chat with your session while reading the PDF and other goodies. 

## Works with

| Host        | Status      |
|-------------|-------------|
| [Claude Code](https://claude.com/claude-code) | Supported |
| Codex       | Supported `.agents/skills/crux-viewer/` |
| Cursor | Supported|
| Claude Cowork | WIP |

## Requirements

- Python 3.12+
- A web browser

## Install

For one project, clone and open the folder in Claude Code:

```bash
git clone https://github.com/damiansproject/CRUX-VIEWER.git
```

To add it to another project as a plugin:

```bash
claude plugin marketplace add damiansproject/CRUX-VIEWER
claude plugin install crux-viewer@crux-viewer-local --scope local
```

## usage

Ask your favorite LLM to open the viewer with the skill and it will automatically start it.
example prompt:
```bash
Open crux viewer on the following PDFs: [file path here]
```
Furthermore, you can also start it by hand:

```bash
python .claude/skills/crux-viewer/scripts/serve_literature.py --run path/to/run
```

Optional flags: `--paper <paper_id>` to open one CRUX extracted source, `--port` (default port being
8765), `--no-open`

## Running it Standalone:
Run the following command to just view PDFs like a normal PDF viewer:

```bash
python .claude/skills/crux-viewer/scripts/serve_literature.py --sources path/to/pdfs
```

## Development

```bash
pip install -e ".[test]"
pytest        # Python suites + every node --test suite (needs Node 20+)
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for layout and ground rules.

## License

[Apache License 2.0](LICENSE)

## The CRUX suite

| Repo | Stage |
|------|-------|
| [CRUX Claims](https://github.com/damiansproject/CRUX-CLAIMS) | Sources → atomic claim bank |
| [CRUX](https://github.com/damiansproject/CRUX) | Hypothesis loop: propose → critique → revise → tournament |
| [CRUX Reports](https://github.com/damiansproject/CRUX-REPORTS) | Skim HTML / PDF pages of a run |
| **CRUX Viewer** (this repo) | Claim quotes highlighted on the original sources |
