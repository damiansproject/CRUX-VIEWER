from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path
from typing import Any, Callable

from lib.catalog import load_paper

Fetch = Callable[..., bytes]

META_DIR = 'literature_meta'
PAPER_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]+$')
DOI_RE = re.compile(r'(?:doi:\s*)?(10\.\d{4,9}/[-._;()/:A-Z0-9]+)', re.I)
ARXIV_DOT_RE = re.compile(r'(?<!\d)(\d{4}\.\d{4,5})(?:v\d+)?(?!\d)')
ARXIV_UNDERSCORE_RE = re.compile(r'(?<!\d)(\d{4})_(\d{4,5})(?:_|$)')
PMID_URL_RE = re.compile(r'pubmed\.ncbi\.nlm\.nih\.gov/(\d{5,9})', re.I)
PMID_LABEL_RE = re.compile(r'\bpmid:\s*(\d{5,9})\b', re.I)
TAG_RE = re.compile(r'<[^>]+>')
MONTHS = {
    'jan': 1,
    'feb': 2,
    'mar': 3,
    'apr': 4,
    'may': 5,
    'jun': 6,
    'jul': 7,
    'aug': 8,
    'sep': 9,
    'oct': 10,
    'nov': 11,
    'dec': 12,
}
INFO_KEYS = (
    'title',
    'authors',
    'year',
    'month',
    'day',
    'issue',
    'journal',
    'language',
    'pages',
    'translators',
    'volume',
    'abstract',
    'date_accessed',
    'doi',
    'arxiv',
    'pmid',
    'isbn',
    'issn',
)
UA = 'CRUX-literature/1.0 (https://github.com/crux)'
ATOM = {'atom': 'http://www.w3.org/2005/Atom', 'arxiv': 'http://arxiv.org/schemas/atom'}


def parse_doi(text: object) -> str | None:
    if not isinstance(text, str):
        return None
    match = DOI_RE.search(text)
    if not match:
        return None
    return match.group(1).rstrip(').,;').lower()


def parse_arxiv(text: object) -> str | None:
    if not isinstance(text, str):
        return None
    stripped = text.strip()
    dotted = ARXIV_DOT_RE.search(stripped)
    if dotted:
        return dotted.group(1)
    under = ARXIV_UNDERSCORE_RE.search(stripped)
    if under:
        return f'{under.group(1)}.{under.group(2)}'
    return None


def parse_pmid(text: object) -> str | None:
    if not isinstance(text, str):
        return None
    match = PMID_URL_RE.search(text)
    if match:
        return match.group(1)
    match = PMID_LABEL_RE.search(text)
    return match.group(1) if match else None


def load_overlay(run_dir: Path | str, paper_id: str) -> dict[str, Any]:
    path = _overlay_path(run_dir, paper_id)
    if not path.is_file():
        return {}
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {}
    return _clean_overlay(raw if isinstance(raw, dict) else {})


def save_overlay(run_dir: Path | str, paper_id: str, payload: object) -> dict[str, Any]:
    cleaned = _clean_overlay(payload if isinstance(payload, dict) else {})
    path = _overlay_path(run_dir, paper_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.json.tmp')
    tmp.write_text(
        json.dumps({'v': 1, **cleaned}, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
    tmp.replace(path)
    return cleaned


def load_info(run_dir: Path | str, paper_id: str) -> dict[str, Any]:
    run_dir = Path(run_dir)
    paper = load_paper(run_dir, paper_id)
    index_meta = _index_row(run_dir, paper_id)
    gist = _gist_for(run_dir, paper_id)
    if gist and not index_meta.get('gist'):
        index_meta = {**index_meta, 'gist': gist}
    overlay = load_overlay(run_dir, paper_id)
    return build_info(
        paper,
        index_meta=index_meta,
        overlay=overlay,
        claims=paper.get('claims') or [],
    )


def build_info(
    paper: dict[str, Any],
    *,
    index_meta: dict[str, Any] | None = None,
    overlay: dict[str, Any] | None = None,
    claims: list[dict[str, Any]] | None = None,
) -> dict[str, Any]:
    index_meta = index_meta or {}
    overlay = _clean_overlay(overlay or {})
    claims = claims or []
    source = claims[0].get('source') if claims and isinstance(claims[0].get('source'), dict) else {}
    if not isinstance(source, dict):
        source = {}

    blobs = [
        paper.get('paper_id'),
        paper.get('title'),
        paper.get('source_url'),
        paper.get('source_pdf'),
        index_meta.get('source_url'),
        source.get('url'),
        overlay.get('doi'),
        overlay.get('arxiv'),
        overlay.get('pmid'),
        *(overlay.get('urls') or []),
    ]
    urls = _unique_urls(
        [
            paper.get('source_url'),
            index_meta.get('source_url'),
            source.get('url'),
            *(overlay.get('urls') or []),
        ]
    )
    info: dict[str, Any] = {
        'paper_id': paper.get('paper_id'),
        'title': _text(paper.get('title')),
        'authors': None,
        'year': None,
        'month': None,
        'day': None,
        'issue': None,
        'journal': _text(index_meta.get('venue')) or _text(source.get('venue')),
        'language': None,
        'pages': None,
        'translators': None,
        'volume': None,
        'abstract': _text(index_meta.get('gist')) or _text(paper.get('gist')),
        'date_accessed': None,
        'doi': _first(parse_doi, blobs),
        'arxiv': _first(parse_arxiv, blobs),
        'pmid': _first(parse_pmid, blobs),
        'isbn': None,
        'issn': None,
        'urls': urls,
        'origin': paper.get('origin'),
        'page_count': paper.get('page_count'),
        'source_type': _text(source.get('type')) or _text(index_meta.get('source_type')),
        'pdf_ok': bool(paper.get('pdf_ok')),
        'can_get_pdf': bool(paper.get('pdf_ok')),
        'can_read': True,
        'pdf_name': Path(str(paper['source_pdf'])).name if paper.get('source_pdf') else None,
    }
    for key in INFO_KEYS:
        if key not in overlay:
            continue
        val = overlay[key]
        if key in ('year', 'month', 'day'):
            info[key] = val
        elif key == 'doi' and isinstance(val, str):
            info[key] = parse_doi(val) or val.strip().lower()
        elif key == 'arxiv' and isinstance(val, str):
            info[key] = parse_arxiv(val) or val.strip()
        elif key == 'pmid' and isinstance(val, str):
            info[key] = parse_pmid(val) or val.strip()
        else:
            info[key] = val
    if overlay.get('urls'):
        info['urls'] = _unique_urls([*info['urls'], *overlay['urls']])
    if info.get('arxiv'):
        info['urls'] = _unique_urls([*info['urls'], f'https://arxiv.org/abs/{info["arxiv"]}'])
    return info


def resolve_identifier(kind: str, value: str, fetch: Fetch | None = None) -> dict[str, Any]:
    fetch = fetch or default_fetch
    if kind == 'doi':
        doi = parse_doi(value) or str(value).strip().lower()
        if not doi:
            raise ValueError('doi required')
        url = 'https://api.crossref.org/works/' + urllib.parse.quote(doi)
        data = json.loads(fetch(url, timeout=20).decode('utf-8'))
        return _from_crossref(data, doi)
    if kind == 'arxiv':
        arxiv_id = parse_arxiv(value) or str(value).strip()
        if not arxiv_id:
            raise ValueError('arxiv id required')
        url = f'https://export.arxiv.org/api/query?id_list={urllib.parse.quote(arxiv_id)}'
        return _from_arxiv(fetch(url, timeout=20), arxiv_id)
    if kind == 'pmid':
        pmid = parse_pmid(value) or re.sub(r'\D', '', str(value))
        if not pmid:
            raise ValueError('pmid required')
        url = (
            'https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi'
            f'?db=pubmed&id={urllib.parse.quote(pmid)}&retmode=json'
        )
        data = json.loads(fetch(url, timeout=20).decode('utf-8'))
        return _from_pubmed(data, pmid)
    raise ValueError('unknown identifier')


def apply_resolved(run_dir: Path | str, paper_id: str, fields: dict[str, Any]) -> dict[str, Any]:
    overlay = load_overlay(run_dir, paper_id)
    for key, val in fields.items():
        if key == 'urls' and isinstance(val, list):
            overlay['urls'] = _unique_urls([*(overlay.get('urls') or []), *val])
            continue
        if val in (None, ''):
            continue
        overlay[key] = val
    save_overlay(run_dir, paper_id, overlay)
    return load_info(run_dir, paper_id)


def default_fetch(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def _from_crossref(data: dict[str, Any], doi: str) -> dict[str, Any]:
    msg = data.get('message') if isinstance(data, dict) else None
    if not isinstance(msg, dict):
        raise ValueError('crossref: no message')
    year, month, day = _date_parts(msg)
    titles = msg.get('title') if isinstance(msg.get('title'), list) else []
    journals = msg.get('container-title') if isinstance(msg.get('container-title'), list) else []
    issns = msg.get('ISSN') if isinstance(msg.get('ISSN'), list) else []
    authors = _crossref_authors(msg.get('author'))
    out = {
        'title': _text(titles[0] if titles else None),
        'authors': authors,
        'year': year,
        'month': month,
        'day': day,
        'journal': _text(journals[0] if journals else None),
        'volume': _text(msg.get('volume')),
        'issue': _text(msg.get('issue')),
        'pages': _text(msg.get('page')),
        'doi': parse_doi(str(msg.get('DOI') or doi)) or doi.lower(),
        'issn': _text(issns[0] if issns else None),
        'language': _text(msg.get('language')),
        'abstract': _strip_tags(msg.get('abstract')),
        'urls': _unique_urls([msg.get('URL')]),
    }
    return {k: v for k, v in out.items() if v not in (None, '', [])}


def _from_arxiv(raw: bytes, arxiv_id: str) -> dict[str, Any]:
    root = ET.fromstring(raw)
    entry = root.find('atom:entry', ATOM)
    if entry is None:
        raise ValueError('arxiv: no entry')
    title = _space(_text(entry.findtext('atom:title', default='', namespaces=ATOM)))
    summary = _space(_text(entry.findtext('atom:summary', default='', namespaces=ATOM)))
    published = entry.findtext('atom:published', default='', namespaces=ATOM) or ''
    year = month = day = None
    match = re.match(r'(\d{4})-(\d{2})-(\d{2})', published)
    if match:
        year, month, day = int(match.group(1)), int(match.group(2)), int(match.group(3))
    authors = [
        _text(node.findtext('atom:name', default='', namespaces=ATOM))
        for node in entry.findall('atom:author', ATOM)
    ]
    doi_el = entry.find('arxiv:doi', ATOM)
    doi = parse_doi(doi_el.text if doi_el is not None else None)
    out = {
        'title': title,
        'authors': ', '.join(a for a in authors if a) or None,
        'year': year,
        'month': month,
        'day': day,
        'abstract': summary,
        'doi': doi,
        'arxiv': arxiv_id,
        'journal': 'arXiv',
        'urls': [f'https://arxiv.org/abs/{arxiv_id}'],
    }
    return {k: v for k, v in out.items() if v not in (None, '', [])}


def _from_pubmed(data: dict[str, Any], pmid: str) -> dict[str, Any]:
    result = data.get('result') if isinstance(data, dict) else None
    row = result.get(pmid) if isinstance(result, dict) else None
    if not isinstance(row, dict):
        raise ValueError('pubmed: no record')
    authors = []
    for item in row.get('authors') or []:
        if isinstance(item, dict) and _text(item.get('name')):
            authors.append(_text(item.get('name')))
    year, month, day = _parse_pubdate(_text(row.get('pubdate')))
    doi = parse_doi(_text(row.get('elocationid')) or '') or parse_doi(_text(row.get('articleids')))
    if not doi:
        for item in row.get('articleids') or []:
            if isinstance(item, dict) and item.get('idtype') == 'doi':
                doi = parse_doi(str(item.get('value') or ''))
                break
    out = {
        'title': _text(row.get('title')),
        'authors': ', '.join(authors) or _text(row.get('sortfirstauthor')),
        'year': year,
        'month': month,
        'day': day,
        'journal': _text(row.get('source')),
        'volume': _text(row.get('volume')),
        'issue': _text(row.get('issue')),
        'pages': _text(row.get('pages')),
        'issn': _text(row.get('issn')),
        'doi': doi,
        'pmid': pmid,
    }
    return {k: v for k, v in out.items() if v not in (None, '', [])}


def _crossref_authors(raw: object) -> str | None:
    if not isinstance(raw, list):
        return None
    names: list[str] = []
    for row in raw:
        if not isinstance(row, dict):
            continue
        family = _text(row.get('family')) or ''
        given = _text(row.get('given')) or ''
        label = ' '.join(p for p in (family, given) if p).strip()
        if label:
            names.append(label)
    return ', '.join(names) or None


def _date_parts(msg: dict[str, Any]) -> tuple[int | None, int | None, int | None]:
    for key in ('published-print', 'published-online', 'published', 'created'):
        block = msg.get(key)
        parts = None
        if isinstance(block, dict):
            raw = block.get('date-parts')
            if isinstance(raw, list) and raw and isinstance(raw[0], list) and raw[0]:
                parts = raw[0]
        if parts:
            year = _intish(parts[0]) if len(parts) > 0 else None
            month = _intish(parts[1]) if len(parts) > 1 else None
            day = _intish(parts[2]) if len(parts) > 2 else None
            return year, month, day
    return None, None, None


def _parse_pubdate(text: str | None) -> tuple[int | None, int | None, int | None]:
    if not text:
        return None, None, None
    parts = text.replace(',', ' ').split()
    year = _intish(parts[0]) if parts else None
    month = None
    day = None
    if len(parts) > 1:
        month = MONTHS.get(parts[1][:3].lower())
    if len(parts) > 2:
        day = _intish(parts[2])
    return year, month, day


def _clean_overlay(raw: dict[str, Any]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key in INFO_KEYS:
        if key not in raw:
            continue
        val = raw[key]
        if val is None or val == '':
            continue
        if key in ('year', 'month', 'day'):
            n = _intish(val)
            if n is not None:
                out[key] = n
            continue
        if isinstance(val, str) and val.strip():
            out[key] = val.strip()
    urls = raw.get('urls')
    if isinstance(urls, list):
        cleaned = _unique_urls(urls)
        if cleaned:
            out['urls'] = cleaned
    return out


def _overlay_path(run_dir: Path | str, paper_id: str) -> Path:
    if not isinstance(paper_id, str) or not PAPER_ID_RE.match(paper_id):
        raise ValueError('invalid paper id')
    root = (Path(run_dir) / META_DIR).resolve()
    path = (root / f'{paper_id}.json').resolve()
    path.relative_to(root)
    return path


def _index_row(run_dir: Path, paper_id: str) -> dict[str, Any]:
    path = run_dir / 'cleaned_jsons' / 'index.json'
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {}
    for item in data.get('papers') or []:
        if isinstance(item, dict) and item.get('paper_id') == paper_id:
            return item
    return {}


def _gist_for(run_dir: Path, paper_id: str) -> str | None:
    path = run_dir / 'gists.json'
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None
    for item in data.get('papers') or []:
        if isinstance(item, dict) and item.get('paper_id') == paper_id:
            return _text(item.get('gist'))
    return None


def _unique_urls(values: list[object]) -> list[str]:
    out: list[str] = []
    seen: set[str] = set()
    for val in values:
        if not isinstance(val, str):
            continue
        href = val.strip()
        if not href or href in seen:
            continue
        seen.add(href)
        out.append(href)
    return out


def _first(parser: Callable[[object], str | None], blobs: list[object]) -> str | None:
    for blob in blobs:
        got = parser(blob)
        if got:
            return got
    return None


def _text(val: object) -> str | None:
    if isinstance(val, str) and val.strip():
        return val.strip()
    return None


def _space(val: str | None) -> str | None:
    if not val:
        return None
    return re.sub(r'\s+', ' ', val).strip() or None


def _strip_tags(val: object) -> str | None:
    if not isinstance(val, str) or not val.strip():
        return None
    text = re.sub(r'</(?:jats:)?p>', ' ', val, flags=re.I)
    text = TAG_RE.sub('', text)
    return _space(text)


def _intish(val: object) -> int | None:
    if isinstance(val, bool):
        return None
    if isinstance(val, int):
        return val
    if isinstance(val, str) and val.strip().isdigit():
        return int(val.strip())
    return None
