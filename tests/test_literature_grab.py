"""Grabbing open-access copies of cited papers."""
from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'crux-viewer' / 'scripts'
sys.path.insert(0, str(SCRIPTS))

import serve_literature  # noqa: E402
from lib.grab import (  # noqa: E402
    arxiv_id,
    best_work,
    doi_of,
    grab,
    probable_title,
    title_score,
    work_urls,
)
from serve_literature import bind_server, make_handler  # noqa: E402

from test_literature_catalog import _write_run  # noqa: E402

ENTRY = (
    'J. Betley, D. Tan, and N. Warncke. Emergent misalignment: narrow finetuning '
    'can produce broadly misaligned LLMs. arXiv preprint arXiv:2502.17424, 2025.'
)
PDF = b'%PDF-1.5 fake body'


def test_arxiv_and_doi_extraction() -> None:
    assert arxiv_id(ENTRY) == '2502.17424'
    assert arxiv_id('no identifiers here, 2502.17424 without the word') is None
    assert doi_of('see https://doi.org/10.1038/s41586-021-03819-2.') == '10.1038/s41586-021-03819-2'
    assert doi_of('nothing') is None


def test_title_score_and_best_work() -> None:
    assert title_score('Emergent misalignment: narrow finetuning', ENTRY) == 1.0
    assert title_score('Unrelated quantum lattice dynamics', ENTRY) == 0.0
    # a two-token overlap is not a match, however high its fraction
    assert title_score('Emergent misalignment', ENTRY) == 0.0
    data = {
        'results': [
            {'title': 'Completely different paper'},
            {'title': 'Emergent misalignment: narrow finetuning can produce broadly misaligned LLMs'},
        ]
    }
    assert best_work(data, ENTRY)['title'].startswith('Emergent misalignment')
    assert best_work({'results': [{'title': 'nope'}]}, ENTRY) is None


def test_probable_title_beats_a_longer_author_list() -> None:
    assert probable_title(ENTRY).startswith('Emergent misalignment')
    assert probable_title('short. tiny.') == 'short. tiny.'
    entry = (
        'Andy Zou, Long Phan, Sarah Chen, James Campbell, Phillip Guo, Richard Ren. '
        'Representation engineering: A top-down approach to AI transparency, 2023.'
    )
    assert probable_title(entry).startswith('Representation engineering')


def test_arxiv_fallback_when_openalex_misses(tmp_path: Path) -> None:
    from lib.grab import arxiv_search, clean_title_query

    entry = (
        'A. Zou, L. Phan, S. Chen. Representation engineering: a top-down '
        'approach to AI transparency, 2023.'
    )
    assert clean_title_query('Representation engineering: A top-down approach, 2023') == (
        'Representation engineering A top down approach'
    )
    # PDF hyphenation splits rejoin before searching and scoring
    assert clean_title_query('a labora- tory for alignment') == 'a laboratory for alignment'
    assert title_score(
        'A general language assistant as a laboratory for alignment',
        'Askell et al. A general language assistant as a labora- tory for alignment, 2021.',
    ) == 1.0
    atom = (
        '<feed><entry><id>http://arxiv.org/abs/2310.01405v4</id>'
        '<title>Representation Engineering: A Top-Down\n Approach to AI Transparency</title>'
        '</entry></feed>'
    ).encode('utf-8')
    hits = {'export.arxiv.org': (atom, 'application/atom+xml')}

    def fake_fetch(url: str):
        if 'export.arxiv.org' in url:
            return hits['export.arxiv.org']
        if url == 'https://arxiv.org/pdf/2310.01405':
            return PDF, 'application/pdf'
        raise AssertionError(url)

    got = arxiv_search(probable_title(entry), entry, fake_fetch)
    assert got[0] == '2310.01405'
    run = _write_run(tmp_path)
    row = grab(run, entry, fetch=fake_fetch, fetch_json=lambda url: {'results': []})
    assert row['origin'] == 'pdf'
    assert 'Representation_Engineering' in row['paper_id']


def test_work_urls_prefers_pdf_locations() -> None:
    pdfs, pages = work_urls(
        {
            'best_oa_location': {'pdf_url': 'https://x/p.pdf', 'landing_page_url': 'https://x/abs'},
            'open_access': {'oa_url': 'https://oa/page'},
            'locations': [{'pdf_url': 'https://y/p2.pdf'}],
        }
    )
    assert pdfs[0] == 'https://x/p.pdf'
    assert 'https://y/p2.pdf' in pdfs
    assert pages[0] == 'https://oa/page'


def test_grab_arxiv_pdf_lands_in_the_library_with_its_real_title(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    fetched = []
    atom = (
        '<feed><title>ArXiv Query</title><entry><id>http://arxiv.org/abs/2502.17424v2</id>'
        '<title>Emergent Misalignment: Narrow finetuning can produce broadly misaligned LLMs</title>'
        '</entry></feed>'
    ).encode('utf-8')

    def fake_fetch(url: str):
        fetched.append(url)
        if 'export.arxiv.org' in url:
            return atom, 'application/atom+xml'
        return PDF, 'application/pdf'

    row = grab(run, ENTRY, fetch=fake_fetch)
    assert fetched[-1] == 'https://arxiv.org/pdf/2502.17424'
    assert row['origin'] == 'pdf'
    assert (run / row['source_pdf']).read_bytes() == PDF
    assert row['title'].startswith('Emergent_Misalignment')

    # title lookup failing still stores the paper, under its arXiv id
    def no_title_fetch(url: str):
        if 'export.arxiv.org' in url:
            raise OSError('offline')
        return PDF, 'application/pdf'

    row2 = grab(run, ENTRY, fetch=no_title_fetch)
    assert 'arXiv_2502_17424' in row2['paper_id']


def test_grab_falls_back_to_openalex_search_and_landing_page(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    entry = 'Zou et al. Representation engineering: a top-down approach to AI transparency. 2023.'
    work = {
        'title': 'Representation engineering: a top-down approach to AI transparency',
        'best_oa_location': {'pdf_url': 'https://host/broken.pdf', 'landing_page_url': 'https://host/abs/1'},
    }

    def fake_fetch(url: str):
        if url.endswith('broken.pdf'):
            return b'<html>paywall</html>', 'text/html'
        raise AssertionError(url)

    row = grab(run, entry, fetch=fake_fetch, fetch_json=lambda url: {'results': [work]})
    assert row['origin'] == 'web'
    assert row['source_url'] == 'https://host/abs/1'

    with pytest.raises(LookupError):
        grab(run, 'garbled entry with no matches 1999',
             fetch=fake_fetch, fetch_json=lambda url: {'results': []})
    with pytest.raises(ValueError):
        grab(run, '', fetch=fake_fetch)


def test_grab_endpoint(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    from lib.sources import add_pdf
    run = _write_run(tmp_path)
    monkeypatch.setattr(
        serve_literature,
        'grab',
        lambda run_dir, entry: add_pdf(run_dir, 'new_paper.pdf', b'%PDF fixture'),
    )
    httpd, port = bind_server(make_handler(run), 18500)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        req = urllib.request.Request(
            f'http://127.0.0.1:{port}/api/grab',
            data=json.dumps({'entry': ENTRY}).encode('utf-8'),
            method='POST',
            headers={'Content-Type': 'application/json'},
        )
        with urllib.request.urlopen(req, timeout=5) as resp:
            assert resp.status == 201
            assert json.loads(resp.read())['paper_id'] == 'new_paper'

        def not_found(run_dir, entry):
            raise LookupError('no open copy found')

        monkeypatch.setattr(serve_literature, 'grab', not_found)
        req2 = urllib.request.Request(
            f'http://127.0.0.1:{port}/api/grab',
            data=json.dumps({'entry': ENTRY}).encode('utf-8'),
            method='POST',
            headers={'Content-Type': 'application/json'},
        )
        try:
            urllib.request.urlopen(req2, timeout=5)
            raise AssertionError('expected 404')
        except urllib.error.HTTPError as err:
            assert err.code == 404
    finally:
        httpd.shutdown()
        httpd.server_close()
