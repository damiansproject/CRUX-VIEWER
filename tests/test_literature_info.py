"""Bibliographic info card for the literature side pane."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'crux-viewer' / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from lib.paper_info import (  # noqa: E402
    build_info,
    load_info,
    parse_arxiv,
    parse_doi,
    parse_pmid,
    resolve_identifier,
    save_overlay,
)
from test_literature_catalog import _write_run  # noqa: E402


def test_parse_doi_from_publisher_and_doi_urls() -> None:
    assert parse_doi('https://doi.org/10.1111/mec.17756') == '10.1111/mec.17756'
    assert (
        parse_doi('https://onlinelibrary.wiley.com/doi/pdf/10.1111/mec.17756')
        == '10.1111/mec.17756'
    )
    assert parse_doi('doi:10.1111/MEC.17756') == '10.1111/mec.17756'
    assert parse_doi('no identifier here') is None


def test_parse_arxiv_from_id_and_label() -> None:
    assert parse_arxiv('2405.14041') == '2405.14041'
    assert parse_arxiv('arXiv:2405.14041v2') == '2405.14041'
    assert parse_arxiv('https://arxiv.org/abs/2405.14041') == '2405.14041'
    assert parse_arxiv('2405_14041_7ab387c0315a11cd') == '2405.14041'
    assert parse_arxiv('notes about 2024') is None


def test_parse_pmid_from_pubmed_url() -> None:
    assert parse_pmid('https://pubmed.ncbi.nlm.nih.gov/40186548/') == '40186548'
    assert parse_pmid('PMID: 40186548') == '40186548'
    assert parse_pmid('https://example.org/40186548') is None


def test_build_info_uses_gist_venue_and_urls(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    index = json.loads((run / 'cleaned_jsons' / 'index.json').read_text(encoding='utf-8'))
    index['papers'][0]['gist'] = 'Fire structures terrestrial ecosystems.'
    index['papers'][0]['venue'] = 'Molecular Ecology'
    index['papers'][0]['source_url'] = 'https://doi.org/10.1111/mec.17756'
    (run / 'cleaned_jsons' / 'index.json').write_text(json.dumps(index), encoding='utf-8')
    claims = json.loads((run / 'claims.jsonl').read_text(encoding='utf-8').splitlines()[0])
    claims['source'] = {
        'type': 'journal',
        'url': 'https://onlinelibrary.wiley.com/doi/10.1111/mec.17756',
        'venue': 'Molecular Ecology',
        'title': 'Fire Frequency Driven Increases',
    }
    (run / 'claims.jsonl').write_text(json.dumps(claims) + '\n', encoding='utf-8')

    info = load_info(run, 'p_one')
    assert info['title'] == 'Example Paper'
    assert info['journal'] == 'Molecular Ecology'
    assert info['abstract'] == 'Fire structures terrestrial ecosystems.'
    assert info['doi'] == '10.1111/mec.17756'
    assert info['origin'] == 'pdf'
    assert info['pdf_ok'] is True
    assert info['can_get_pdf'] is True
    assert info['urls'][0] == 'https://doi.org/10.1111/mec.17756'
    assert 'https://onlinelibrary.wiley.com/doi/10.1111/mec.17756' in info['urls']
    assert info['authors'] is None
    assert info['pmid'] is None


def test_build_info_arxiv_from_paper_id() -> None:
    info = build_info(
        {
            'paper_id': '2405.14041',
            'title': 'Shape-Wilf equivalence',
            'origin': 'pdf',
            'source_pdf': '/tmp/a.pdf',
            'source_url': 'https://arxiv.org/abs/2405.14041',
            'page_count': 12,
            'pdf_ok': True,
        },
        index_meta={'gist': 'A packing gist.'},
        overlay={},
        claims=[],
    )
    assert info['arxiv'] == '2405.14041'
    assert info['abstract'] == 'A packing gist.'
    assert info['urls'] == ['https://arxiv.org/abs/2405.14041']


def test_overlay_fills_blank_fields_without_clobbering_title(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    save_overlay(
        run,
        'p_one',
        {
            'authors': 'Hopkins J, Bennett A, McKenna T',
            'year': 2025,
            'month': 5,
            'day': 1,
            'issue': '10',
            'volume': '34',
            'pages': 'e17756',
            'pmid': '40186548',
            'issn': '1365294X',
            'title': '',
        },
    )
    info = load_info(run, 'p_one')
    assert info['title'] == 'Example Paper'
    assert info['authors'] == 'Hopkins J, Bennett A, McKenna T'
    assert info['year'] == 2025
    assert info['month'] == 5
    assert info['day'] == 1
    assert info['pmid'] == '40186548'
    assert info['issn'] == '1365294X'


def test_resolve_doi_maps_crossref_message() -> None:
    payload = {
        'message': {
            'title': ['Fire Frequency Driven Increases in Burn Heterogeneity'],
            'author': [
                {'family': 'Hopkins', 'given': 'J'},
                {'family': 'Bennett', 'given': 'A'},
            ],
            'container-title': ['Molecular Ecology'],
            'published-print': {'date-parts': [[2025, 5, 1]]},
            'volume': '34',
            'issue': '10',
            'page': 'e17756',
            'DOI': '10.1111/MEC.17756',
            'ISSN': ['1365-294X'],
            'URL': 'https://onlinelibrary.wiley.com/doi/10.1111/mec.17756',
            'abstract': '<jats:p>Fire is a common ecological disturbance.</jats:p>',
            'language': 'en',
        }
    }

    def fetch(url: str, timeout: int = 20) -> bytes:
        assert '10.1111/mec.17756' in url.lower()
        return json.dumps(payload).encode('utf-8')

    got = resolve_identifier('doi', '10.1111/mec.17756', fetch=fetch)
    assert got['journal'] == 'Molecular Ecology'
    assert got['year'] == 2025
    assert got['month'] == 5
    assert got['day'] == 1
    assert got['authors'] == 'Hopkins J, Bennett A'
    assert got['doi'] == '10.1111/mec.17756'
    assert got['abstract'] == 'Fire is a common ecological disturbance.'
    assert got['issn'] == '1365-294X'
    assert got['language'] == 'en'


def test_resolve_arxiv_maps_atom() -> None:
    atom = """<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom"
          xmlns:arxiv="http://arxiv.org/schemas/atom">
      <entry>
        <title>Shape-Wilf equivalence</title>
        <published>2024-05-22T00:00:00Z</published>
        <summary>We study patterns on Ferrers boards.</summary>
        <author><name>Ada Lovelace</name></author>
        <arxiv:doi>10.1234/example</arxiv:doi>
      </entry>
    </feed>
    """

    def fetch(url: str, timeout: int = 20) -> bytes:
        assert '2405.14041' in url
        return atom.encode('utf-8')

    got = resolve_identifier('arxiv', '2405.14041', fetch=fetch)
    assert got['title'] == 'Shape-Wilf equivalence'
    assert got['authors'] == 'Ada Lovelace'
    assert got['year'] == 2024
    assert got['month'] == 5
    assert got['abstract'] == 'We study patterns on Ferrers boards.'
    assert got['doi'] == '10.1234/example'
    assert got['arxiv'] == '2405.14041'
    assert got['journal'] == 'arXiv'


def test_resolve_pmid_maps_esummary() -> None:
    payload = {
        'result': {
            '40186548': {
                'title': 'Fire Frequency Driven Increases',
                'sortfirstauthor': 'Hopkins J',
                'authors': [
                    {'name': 'Hopkins J'},
                    {'name': 'Bennett A'},
                    {'name': 'McKenna T'},
                ],
                'source': 'Mol Ecol',
                'pubdate': '2025 May',
                'volume': '34',
                'issue': '10',
                'pages': 'e17756',
                'issn': '1365-294X',
                'elocationid': 'doi: 10.1111/mec.17756',
            }
        }
    }

    def fetch(url: str, timeout: int = 20) -> bytes:
        assert '40186548' in url
        return json.dumps(payload).encode('utf-8')

    got = resolve_identifier('pmid', '40186548', fetch=fetch)
    assert got['journal'] == 'Mol Ecol'
    assert got['year'] == 2025
    assert got['month'] == 5
    assert got['authors'] == 'Hopkins J, Bennett A, McKenna T'
    assert got['doi'] == '10.1111/mec.17756'
    assert got['pmid'] == '40186548'
