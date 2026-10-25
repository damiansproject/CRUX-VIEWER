from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

from lib.sources import load_added


def _iter_jsonl(path: Path) -> list[dict[str, Any]]:
    rows: list[dict[str, Any]] = []
    for n, line in enumerate(path.read_text(encoding='utf-8').splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        try:
            rows.append(json.loads(line))
        except json.JSONDecodeError as exc:
            raise ValueError(f'{path}:{n}: bad JSON ({exc.msg})') from None
    return rows


def _title_for(meta: dict[str, Any], claims: list[dict[str, Any]], paper_id: str) -> str:
    title = meta.get('title')
    if isinstance(title, str) and title.strip():
        return title.strip()
    if claims:
        source = claims[0].get('source') if isinstance(claims[0].get('source'), dict) else {}
        src_title = source.get('title') if isinstance(source, dict) else None
        if isinstance(src_title, str) and src_title.strip():
            return src_title.strip()
    return paper_id


def _source_url(meta: dict[str, Any], claims: list[dict[str, Any]]) -> str | None:
    url = meta.get('source_url')
    if isinstance(url, str) and url.strip():
        return url.strip()
    if claims:
        source = claims[0].get('source') if isinstance(claims[0].get('source'), dict) else {}
        src_url = source.get('url') if isinstance(source, dict) else None
        if isinstance(src_url, str) and src_url.strip():
            return src_url.strip()
    return None


def _index_papers(run_dir: Path) -> dict[str, dict[str, Any]]:
    index_path = run_dir / 'cleaned_jsons' / 'index.json'
    data = json.loads(index_path.read_text(encoding='utf-8')) if index_path.is_file() else {}
    out: dict[str, dict[str, Any]] = {}
    for item in data.get('papers') or []:
        if not isinstance(item, dict):
            continue
        pid = item.get('paper_id')
        if isinstance(pid, str) and pid:
            out[pid] = item
    for pdf in sorted((run_dir / 'reports').glob('*.pdf')):
        definition = pdf.with_suffix('.report.json')
        meta = json.loads(definition.read_text(encoding='utf-8')) if definition.is_file() else {}
        pid = 'report-' + hashlib.sha256(pdf.name.encode('utf-8')).hexdigest()[:16]
        out[pid] = {**meta, 'paper_id': pid, 'title': meta.get('title') or pdf.stem,
                    'source_pdf': str(pdf.resolve()), 'origin': 'report', 'artifact_name': pdf.name}
    return out


def _claims_by_paper(run_dir: Path) -> dict[str, list[dict[str, Any]]]:
    claims_path = run_dir / 'claims.jsonl'
    if not claims_path.is_file():
        return {}
    by_paper: dict[str, list[dict[str, Any]]] = {}
    for row in _iter_jsonl(claims_path):
        pid = row.get('paper_id')
        if isinstance(pid, str) and pid:
            by_paper.setdefault(pid, []).append(row)
    return by_paper


def _chain_claims(
    meta: dict[str, Any],
    by_paper: dict[str, list[dict[str, Any]]],
) -> list[dict[str, Any]] | None:
    """Claims for a row carrying ``claim_ids``: bank lookup, order preserved.

    Returns None when the row has no claim_ids (caller falls back to the
    paper_id-matched claims). Unknown and duplicate ids are dropped.
    """
    ids = meta.get('claim_ids')
    if not isinstance(ids, list) or not ids:
        return None
    by_id: dict[str, dict[str, Any]] = {}
    for rows in by_paper.values():
        for row in rows:
            cid = row.get('id')
            if isinstance(cid, str) and cid not in by_id:
                by_id[cid] = row
    anchors = meta.get('claim_anchors')
    anchors = anchors if isinstance(anchors, dict) else {}
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for cid in ids:
        if isinstance(cid, str) and cid in by_id and cid not in seen:
            seen.add(cid)
            row = by_id[cid]
            anchor = anchors.get(cid)
            # copy: the bank row is shared with the source paper's own listing
            out.append({**row, 'anchor': anchor} if isinstance(anchor, str) else row)
    return out


def _resolve_pdf(run_dir: Path, source_pdf: object) -> Path | None:
    if not isinstance(source_pdf, str) or not source_pdf.strip():
        return None
    path = Path(source_pdf.strip())
    if not path.is_absolute():
        path = run_dir / path
    return path


def _paper_row(
    run_dir: Path,
    paper_id: str,
    meta: dict[str, Any],
    claims: list[dict[str, Any]],
) -> dict[str, Any]:
    pdf_path = _resolve_pdf(run_dir, meta.get('source_pdf'))
    origin = meta.get('origin') or (claims[0].get('origin') if claims else None) or 'other'
    return {
        'paper_id': paper_id,
        'title': _title_for(meta, claims, paper_id),
        'origin': origin,
        'source_pdf': str(pdf_path) if pdf_path else None,
        'source_url': _source_url(meta, claims),
        'page_count': meta.get('page_count'),
        'claim_count': len(claims),
        'quote_count': sum(len(c.get('quotes') or []) for c in claims),
        'pdf_ok': bool(pdf_path and pdf_path.is_file()),
        'artifact_name': meta.get('artifact_name'),
    }


def load_catalog(run_dir: Path | str) -> dict[str, Any]:
    """List original sources and report PDFs, including sources without banked claims."""
    run_dir = Path(run_dir)
    by_paper = _claims_by_paper(run_dir)
    index_papers = _index_papers(run_dir)
    added = {p['paper_id']: p for p in load_added(run_dir)}
    paper_ids = list(dict.fromkeys([*index_papers, *by_paper, *added]))
    papers = []
    for pid in paper_ids:
        claims = by_paper.get(pid) or []
        meta = {**(added.get(pid) or {}), **(index_papers.get(pid) or {})}
        chain = _chain_claims(meta, by_paper)
        papers.append(_paper_row(run_dir, pid, meta, chain if chain is not None else claims))
    return {'run': str(run_dir.resolve()), 'papers': papers}


def load_claim(run_dir: Path | str, claim_id: str) -> dict[str, Any]:
    """One banked claim row by id, from any paper in the run."""
    for rows in _claims_by_paper(Path(run_dir)).values():
        for row in rows:
            if row.get('id') == claim_id:
                return row
    raise KeyError(claim_id)


def load_paper(run_dir: Path | str, paper_id: str) -> dict[str, Any]:
    """Load one source or report with its applicable banked claims."""
    run_dir = Path(run_dir)
    by_paper = _claims_by_paper(run_dir)
    added = {p['paper_id']: p for p in load_added(run_dir)}
    claims = by_paper.get(paper_id) or []
    if not claims and paper_id not in added and paper_id not in _index_papers(run_dir):
        raise KeyError(paper_id)
    meta = {**(added.get(paper_id) or {}), **(_index_papers(run_dir).get(paper_id) or {})}
    chain = _chain_claims(meta, by_paper)
    if chain is not None:
        claims = chain
    row = _paper_row(run_dir, paper_id, meta, claims)
    row['claims'] = claims
    return row
