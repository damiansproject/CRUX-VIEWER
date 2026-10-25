from __future__ import annotations

"""Fetch an open-access copy of a cited paper and add it to the library.

Given a bibliography entry (or the citing sentence when no entry was found),
try in order: an arXiv id in the entry → arxiv.org PDF; a DOI → OpenAlex; a
title search on OpenAlex. Any URL that yields real PDF bytes is stored via
``sources.add_pdf``; when only an open-access landing page exists it is
registered as a live web source instead. Raises LookupError when nothing
open is found — the viewer shows that, it never guesses.
"""

import json
import re
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Any, Callable

from lib.sources import add_pdf, add_url

OPENALEX = 'https://api.openalex.org/works'
UA = 'crux-viewer/1.0 (local literature viewer; mailto:crux-viewer@localhost)'
ARXIV_HINT = re.compile(r'arxiv', re.I)
ARXIV_ID = re.compile(r'\b(\d{4}\.\d{4,5})(?:v\d+)?\b')
DOI = re.compile(r'\b(10\.\d{4,9}/[^\s"\'<>,;]+)', re.I)
MAX_ENTRY = 800
MIN_TITLE_SCORE = 0.7
MIN_TITLE_TOKENS = 3


def arxiv_id(entry: str) -> str | None:
    s = str(entry or '')
    if not ARXIV_HINT.search(s):
        return None
    m = ARXIV_ID.search(s)
    return m.group(1) if m else None


def doi_of(entry: str) -> str | None:
    m = DOI.search(str(entry or ''))
    if not m:
        return None
    return m.group(1).rstrip('.,;)')


def _dehyphenate(text: str) -> str:
    """PDF extraction leaves "labora- tory"; rejoin before any matching."""
    return re.sub(r'(\w)-\s+(\w)', r'\1\2', str(text or ''))


def _tokens(text: str) -> list[str]:
    out = []
    for tok in re.split(r'[^a-z0-9]+', _dehyphenate(text).casefold()):
        if len(tok) >= 4 and tok not in out:
            out.append(tok)
    return out


def title_score(title: str, entry: str) -> float:
    """Fraction of the candidate title's tokens present in the entry."""
    tokens = _tokens(title)
    if len(tokens) < MIN_TITLE_TOKENS:
        return 0.0
    hay = ' ' + ' '.join(_tokens(entry)) + ' '
    matched = sum(1 for tok in tokens if f' {tok} ' in hay)
    if matched < MIN_TITLE_TOKENS:
        return 0.0
    return matched / len(tokens)


def probable_title(entry: str) -> str:
    """A reference entry's title: of the long sentence segments, the one with
    the lowest comma density — author lists are comma-riddled, titles are not
    — longest winning ties."""
    parts = [p.strip() for p in re.split(r'\.\s+', str(entry or '')) if len(p.strip()) >= 20]
    if not parts:
        return str(entry or '').strip()
    return min(parts, key=lambda p: (round(p.count(',') / len(p), 3), -len(p)))


def clean_title_query(title: str) -> str:
    """Bare words for exact-ish title search: no punctuation, no years."""
    s = re.sub(r'[^A-Za-z0-9 ]+', ' ', _dehyphenate(title))
    s = re.sub(r'\b(1[89]|20)\d{2}\b', ' ', s)
    return re.sub(r'\s+', ' ', s).strip()


def _arxiv_title(aid: str, fetch: Callable[[str], tuple[bytes, str]]) -> str | None:
    try:
        xml, _ = fetch(
            f'http://export.arxiv.org/api/query?id_list={urllib.parse.quote(aid)}&max_results=1'
        )
    except Exception:
        return None
    m = re.search(r'<entry>.*?<title>([^<]*)</title>', xml.decode('utf-8', 'replace'), re.S)
    return ' '.join(m.group(1).split()) if m else None


# OpenAlex misses plenty of arXiv-only preprints; the arXiv API itself is the
# fallback. Atom XML, parsed with the stdlib only.
def arxiv_search(title: str, entry: str, fetch: Callable[[str], tuple[bytes, str]]) -> tuple[str, str] | None:
    q = urllib.parse.quote(f'ti:"{clean_title_query(title)[:200]}"')
    try:
        xml, _ = fetch(f'http://export.arxiv.org/api/query?search_query={q}&max_results=5')
    except Exception:
        return None
    best = None
    for m in re.finditer(r'<entry>(.*?)</entry>', xml.decode('utf-8', 'replace'), re.S):
        block = m.group(1)
        mid = re.search(r'<id>https?://arxiv\.org/abs/([^<]+)</id>', block)
        mtitle = re.search(r'<title>([^<]*)</title>', block, re.S)
        if not mid or not mtitle:
            continue
        cand = ' '.join(mtitle.group(1).split())
        score = title_score(cand, entry)
        if score >= MIN_TITLE_SCORE and (best is None or score > best[0]):
            best = (score, re.sub(r'v\d+$', '', mid.group(1)), cand)
    return (best[1], best[2]) if best else None


def work_urls(work: dict[str, Any]) -> tuple[list[str], list[str]]:
    """(pdf candidates, landing candidates) for one OpenAlex work."""
    pdfs: list[str] = []
    pages: list[str] = []
    spots = [work.get('best_oa_location'), work.get('primary_location')]
    spots.extend(work.get('locations') or [])
    for spot in spots:
        if not isinstance(spot, dict):
            continue
        pdf = spot.get('pdf_url')
        if isinstance(pdf, str) and pdf and pdf not in pdfs:
            pdfs.append(pdf)
        page = spot.get('landing_page_url')
        if isinstance(page, str) and page and page not in pages:
            pages.append(page)
    oa = work.get('open_access') if isinstance(work.get('open_access'), dict) else {}
    oa_url = oa.get('oa_url')
    if isinstance(oa_url, str) and oa_url:
        (pdfs if oa_url.lower().endswith('.pdf') else pages).insert(0, oa_url)
    return pdfs[:4], pages[:2]


def best_work(data: object, entry: str) -> dict[str, Any] | None:
    rows = data.get('results') if isinstance(data, dict) else None
    if not isinstance(rows, list):
        return None
    best = None
    for work in rows[:5]:
        if not isinstance(work, dict):
            continue
        score = title_score(work.get('title') or '', entry)
        if score >= MIN_TITLE_SCORE and (best is None or score > best[0]):
            best = (score, work)
    return best[1] if best else None


def _fetch(url: str, timeout: int = 30) -> tuple[bytes, str]:
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*'})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read(), resp.headers.get_content_type() or ''


def _fetch_json(url: str) -> object:
    data, _ = _fetch(url, timeout=25)
    return json.loads(data.decode('utf-8'))


def _pdf_name(title: str | None, fallback: str) -> str:
    stem = re.sub(r'[^A-Za-z0-9]+', '_', str(title or fallback)).strip('_')[:60]
    return f'{stem or "grabbed_source"}.pdf'


def grab(
    run_dir: Path | str,
    entry: object,
    fetch: Callable[[str], tuple[bytes, str]] = _fetch,
    fetch_json: Callable[[str], object] = _fetch_json,
) -> dict[str, Any]:
    """Find and store an open copy for a bibliography entry. Returns the row."""
    if not isinstance(entry, str) or not entry.strip():
        raise ValueError('entry required')
    entry = entry.strip()[:MAX_ENTRY]
    pdf_urls: list[str] = []
    page_urls: list[str] = []
    title = None
    aid = arxiv_id(entry)
    if aid:
        pdf_urls.append(f'https://arxiv.org/pdf/{aid}')
        # the real title, so the stored paper matches future citations
        title = _arxiv_title(aid, fetch) or f'arXiv_{aid.replace(".", "_")}'
    else:
        doi = doi_of(entry)
        data = None
        if doi:
            quoted = urllib.parse.quote(doi, safe='')
            try:
                data = fetch_json(f'{OPENALEX}?filter=doi:{quoted}&per-page=1')
            except Exception:
                data = None
        work = best_work(data, entry) if data else None
        if not work:
            q = urllib.parse.quote(clean_title_query(probable_title(entry))[:200])
            try:
                work = best_work(
                    fetch_json(f'{OPENALEX}?filter=title.search:{q}&per-page=5'), entry
                )
            except Exception:
                work = None
        if work:
            title = work.get('title') or None
            pdf_urls, page_urls = work_urls(work)
        if not pdf_urls:
            hit = arxiv_search(probable_title(entry), entry, fetch)
            if hit:
                pdf_urls.insert(0, f'https://arxiv.org/pdf/{hit[0]}')
                title = title or hit[1]
    for url in pdf_urls:
        try:
            data, ctype = fetch(url)
        except Exception:
            continue
        if data.startswith(b'%PDF'):
            return add_pdf(run_dir, _pdf_name(title, url.rsplit('/', 1)[-1]), data)
        if 'html' in ctype and url not in page_urls:
            page_urls.append(url)
    if page_urls:
        return add_url(run_dir, page_urls[0])
    raise LookupError('no open copy found')
