from __future__ import annotations

import json
import os
import re
import urllib.parse
from pathlib import Path
from typing import Any

PAPER_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]+$')
SOURCES_FILE = 'literature_sources.json'
INBOX_DIR = 'literature_inbox'
STANDALONE_RUN_DIR = '.crux-viewer'
MAX_PDF = 80 * 1024 * 1024
SLUG_RE = re.compile(r'[^A-Za-z0-9_.:-]+')


def load_added(run_dir: Path | str) -> list[dict[str, Any]]:
    path = Path(run_dir) / SOURCES_FILE
    if not path.is_file():
        return []
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return []
    papers = raw.get('papers') if isinstance(raw, dict) else None
    if not isinstance(papers, list):
        return []
    out: list[dict[str, Any]] = []
    for row in papers:
        parsed = _parse_row(row)
        if parsed:
            out.append(parsed)
    return out


def add_pdf(run_dir: Path | str, filename: str, data: bytes) -> dict[str, Any]:
    run_dir = Path(run_dir)
    if not data.startswith(b'%PDF'):
        raise ValueError('not a PDF')
    if len(data) > MAX_PDF:
        raise ValueError('pdf too large')
    name = Path(str(filename).replace('\\', '/')).name or 'source.pdf'
    paper_id = _unique_id(_slug(Path(name).stem), _taken_ids(run_dir))
    inbox = run_dir / INBOX_DIR
    inbox.mkdir(parents=True, exist_ok=True)
    rel = f'{INBOX_DIR}/{paper_id}.pdf'
    (run_dir / rel).write_bytes(data)
    row = {
        'paper_id': paper_id,
        'title': Path(name).stem or paper_id,
        'origin': 'pdf',
        'source_pdf': rel,
        'source_url': None,
    }
    _append_row(run_dir, row)
    return row


def add_url(run_dir: Path | str, url: str) -> dict[str, Any]:
    run_dir = Path(run_dir)
    href = str(url).strip()
    parsed = urllib.parse.urlparse(href)
    if parsed.scheme not in ('http', 'https') or not parsed.netloc:
        raise ValueError('url must be http(s)')
    paper_id = _unique_id(_slug_url(parsed), _taken_ids(run_dir))
    host = parsed.netloc
    path = parsed.path.rstrip('/') or ''
    title = f'{host}{path}' if path else host
    row = {
        'paper_id': paper_id,
        'title': title,
        'origin': 'web',
        'source_pdf': None,
        'source_url': href,
    }
    _append_row(run_dir, row)
    return row


def scaffold_folder(folder: Path | str, run_dir: Path | str | None = None) -> Path:
    """Point a run dir at a plain folder of PDFs, one sources row per file.

    Scans ``folder`` for top-level ``*.pdf`` only (no recursion). PDFs are
    served in place as absolute paths, never copied. Idempotent: rows are keyed
    by resolved pdf path, so existing ids/titles survive, rows whose file
    vanished stay (``pdf_ok`` reports them), and picker-added rows are kept.
    """
    folder = Path(folder)
    if not folder.is_dir():
        raise FileNotFoundError(f'sources folder not found: {folder}')
    pdfs = sorted(
        (p for p in folder.iterdir() if p.suffix.lower() == '.pdf' and p.is_file()),
        key=lambda p: p.name.lower(),
    )
    if not pdfs:
        raise ValueError(f'no PDFs in {folder.resolve()}')
    run_dir = Path(run_dir) if run_dir else folder / STANDALONE_RUN_DIR
    run_dir.mkdir(parents=True, exist_ok=True)
    claims = run_dir / 'claims.jsonl'
    if not claims.exists():
        claims.write_bytes(b'')
    papers = load_added(run_dir)
    known = {_pdf_key(run_dir, row['source_pdf']) for row in papers if row['source_pdf']}
    taken = _taken_ids(run_dir)
    fresh: list[dict[str, Any]] = []
    for pdf in pdfs:
        if _pdf_key(run_dir, str(pdf.resolve())) in known:  # a relative path would resolve against run_dir
            continue
        paper_id = _unique_id(_slug(pdf.stem), taken)
        taken.add(paper_id)
        fresh.append(
            {
                'paper_id': paper_id,
                'title': pdf.stem or paper_id,
                'origin': 'pdf',
                'source_pdf': str(pdf.resolve()),
                'source_url': None,
            }
        )
    if fresh:
        _write_rows(run_dir, papers + fresh)
    return run_dir


def _pdf_key(run_dir: Path, source_pdf: str) -> str:
    path = Path(source_pdf)
    if not path.is_absolute():
        path = run_dir / path
    try:
        path = path.resolve()
    except OSError:
        pass
    return os.path.normcase(str(path))


def _parse_row(row: object) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    paper_id = row.get('paper_id')
    if not isinstance(paper_id, str) or not PAPER_ID_RE.match(paper_id):
        return None
    origin = row.get('origin')
    if origin not in ('pdf', 'web'):
        return None
    title = row.get('title')
    if not isinstance(title, str) or not title.strip():
        title = paper_id
    source_pdf = row.get('source_pdf')
    source_url = row.get('source_url')
    out = {
        'paper_id': paper_id,
        'title': title.strip(),
        'origin': origin,
        'source_pdf': source_pdf if isinstance(source_pdf, str) and source_pdf.strip() else None,
        'source_url': source_url if isinstance(source_url, str) and source_url.strip() else None,
    }
    # Optional: a document (e.g. a CRUX report PDF) that cites claims from
    # OTHER papers lists them here, in reading order (claim-chain order).
    # The viewer then shows exactly these claims, in this order.
    claim_ids = row.get('claim_ids')
    if isinstance(claim_ids, list):
        claim_ids = [c.strip() for c in claim_ids if isinstance(c, str) and c.strip()]
        if claim_ids:
            out['claim_ids'] = claim_ids
    # Optional: the clause each claim is cited on in THIS document. The viewer
    # highlights that clause instead of the source quote, which lives in the pane.
    anchors = row.get('claim_anchors')
    if isinstance(anchors, dict):
        anchors = {
            k: v.strip() for k, v in anchors.items()
            if isinstance(k, str) and isinstance(v, str) and v.strip()
        }
        if anchors:
            out['claim_anchors'] = anchors
    return out


def _append_row(run_dir: Path, row: dict[str, Any]) -> None:
    _write_rows(run_dir, [*load_added(run_dir), row])


def _write_rows(run_dir: Path, papers: list[dict[str, Any]]) -> None:
    path = run_dir / SOURCES_FILE
    tmp = path.with_suffix('.json.tmp')
    tmp.write_text(
        json.dumps({'v': 1, 'papers': papers}, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
    tmp.replace(path)


def _slug(raw: str) -> str:
    slug = SLUG_RE.sub('_', raw).strip('._-')
    slug = slug[:60] or 'src'
    if not PAPER_ID_RE.match(slug):
        slug = 'src'
    return slug


def _slug_url(parsed: urllib.parse.ParseResult) -> str:
    host = parsed.netloc.replace(':', '_')
    path = parsed.path.strip('/').replace('/', '_')
    return _slug(f'{host}_{path}' if path else host)


def _unique_id(base: str, taken: set[str]) -> str:
    pid = base
    n = 2
    while pid in taken:
        pid = f'{base}_{n}'
        n += 1
    return pid


def _taken_ids(run_dir: Path) -> set[str]:
    ids: set[str] = {row['paper_id'] for row in load_added(run_dir)}
    claims = run_dir / 'claims.jsonl'
    if claims.is_file():
        for line in claims.read_text(encoding='utf-8').splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            pid = row.get('paper_id') if isinstance(row, dict) else None
            if isinstance(pid, str) and pid:
                ids.add(pid)
    index_path = run_dir / 'cleaned_jsons' / 'index.json'
    if index_path.is_file():
        try:
            data = json.loads(index_path.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError):
            data = {}
        for item in data.get('papers') or []:
            if not isinstance(item, dict):
                continue
            pid = item.get('paper_id')
            if isinstance(pid, str) and pid:
                ids.add(pid)
    return ids
