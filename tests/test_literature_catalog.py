"""Catalog + quote matching for crux-viewer (no HTTP)."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'crux-viewer' / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from lib.catalog import load_catalog, load_paper  # noqa: E402
from lib.match_text import find_all_quotes, find_quote  # noqa: E402


def _write_run(tmp_path: Path, *, web: bool = False) -> Path:
    run = tmp_path / 'run'
    cleaned = run / 'cleaned_jsons'
    cleaned.mkdir(parents=True)
    pdf = run / 'input' / 'paper.pdf'
    pdf.parent.mkdir()
    pdf.write_bytes(b'%PDF-1.4 fake')
    paper = {
        'paper_id': 'p_one',
        'origin': 'web' if web else 'pdf',
        'source_pdf': None if web else str(pdf),
        'source_url': 'https://example.org/article' if web else None,
        'text_path': str(cleaned / 'p_one.json'),
        'page_count': 2,
        'status': 'ok',
        'title': 'Example Paper',
    }
    (cleaned / 'index.json').write_text(
        json.dumps({'papers': [paper]}), encoding='utf-8'
    )
    claims = [
        {
            'id': 'clm_p_one_0001',
            'paper_id': 'p_one',
            'kind': 'finding',
            'statement': 'X is Y',
            'quotes': [
                {
                    'text': 'X is Y on the page',
                    'locator': {'paper': 'p_one', 'page': 1},
                }
            ],
        }
    ]
    (run / 'claims.jsonl').write_text(
        '\n'.join(json.dumps(c) for c in claims) + '\n', encoding='utf-8'
    )
    return run


def test_load_catalog_lists_pdf_paper(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    cat = load_catalog(run)
    assert len(cat['papers']) == 1
    row = cat['papers'][0]
    assert row['paper_id'] == 'p_one'
    assert row['title'] == 'Example Paper'
    assert row['origin'] == 'pdf'
    assert row['claim_count'] == 1
    assert row['quote_count'] == 1
    assert row['pdf_ok'] is True
    assert row['source_url'] is None


def test_load_catalog_web_paper(tmp_path: Path) -> None:
    run = _write_run(tmp_path, web=True)
    row = load_catalog(run)['papers'][0]
    assert row['origin'] == 'web'
    assert row['source_url'] == 'https://example.org/article'
    assert row['pdf_ok'] is False


def test_load_paper_includes_quotes(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    paper = load_paper(run, 'p_one')
    assert paper['paper_id'] == 'p_one'
    assert paper['claims'][0]['id'] == 'clm_p_one_0001'
    assert paper['claims'][0]['quotes'][0]['locator']['page'] == 1


def test_catalog_includes_added_pdf_without_claims(tmp_path: Path) -> None:
    from lib.sources import add_pdf

    run = _write_run(tmp_path)
    row = add_pdf(run, 'Extra Notes.pdf', b'%PDF-1.4 extra')
    cat = load_catalog(run)
    ids = [p['paper_id'] for p in cat['papers']]
    assert ids[0] == 'p_one'
    assert row['paper_id'] in ids
    extra = next(p for p in cat['papers'] if p['paper_id'] == row['paper_id'])
    assert extra['claim_count'] == 0
    assert extra['origin'] == 'pdf'
    assert extra['pdf_ok'] is True
    paper = load_paper(run, row['paper_id'])
    assert paper['claims'] == []
    assert Path(paper['source_pdf']).is_file()


def test_add_url_is_loadable(tmp_path: Path) -> None:
    from lib.sources import add_url

    run = _write_run(tmp_path)
    row = add_url(run, 'https://example.org/paper')
    paper = load_paper(run, row['paper_id'])
    assert paper['origin'] == 'web'
    assert paper['source_url'] == 'https://example.org/paper'


def test_find_quote_collapses_whitespace() -> None:
    page = 'We prove a conjecture of Gao and Kitaev on Wilf-equivalence'
    quote = 'We prove a  conjecture of Gao  and Kitaev'
    span = find_quote(page, quote)
    assert span is not None
    assert 'conjecture of Gao' in page[span.start : span.end]


def test_find_quote_tight_punctuation() -> None:
    page = 'sets {12345,12354} and more'
    quote = 'sets { 12345 , 12354 } and more'
    span = find_quote(page, quote)
    assert span is not None
    assert '{12345,12354}' in page[span.start : span.end]


def test_find_quote_dehyphenates_line_break() -> None:
    page = 'shape-Wilf-\nequivalence of patterns'
    quote = 'shape-Wilf-equivalence of patterns'
    span = find_quote(page, quote)
    assert span is not None


def test_find_quote_missing() -> None:
    assert find_quote('hello world', 'not present') is None


def test_find_quote_joins_hyphen_space_split() -> None:
    page = 'shape-Wilf-equivalence results of Backelin'
    quote = 'shape- Wilfequivalence results of Backelin'
    assert find_quote(page, quote) is not None


def test_find_quote_maps_fi_ligature() -> None:
    page = 'A \ufb01lling of a Ferrers board'
    quote = 'A filling of a Ferrers board'
    assert find_quote(page, quote) is not None


def test_find_all_quotes_multiple() -> None:
    page = 'foo bar foo'
    spans = find_all_quotes(page, 'foo')
    assert [(s.start, s.end) for s in spans] == [(0, 3), (8, 11)]


def test_find_all_quotes_empty() -> None:
    assert find_all_quotes('hello', '  ') == []
    assert find_all_quotes('hello', 'xyz') == []

def _add_bank_claim(run: Path, claim_id: str, paper_id: str, kind: str, statement: str) -> None:
    row = {
        'id': claim_id, 'paper_id': paper_id, 'kind': kind, 'statement': statement,
        'quotes': [{'text': f'{statement} verbatim', 'locator': {'paper': paper_id, 'page': 1}}],
    }
    with (run / 'claims.jsonl').open('a', encoding='utf-8') as fh:
        fh.write(json.dumps(row) + '\n')


def test_claim_ids_row_shows_bank_claims_in_chain_order(tmp_path: Path) -> None:
    from lib.sources import _write_rows, add_pdf, load_added

    run = _write_run(tmp_path)
    _add_bank_claim(run, 'clm_p_two_0004', 'p_two', 'mechanism', 'Axis movement is causal')
    _add_bank_claim(run, 'clm_p_one_0009', 'p_one', 'limitation', 'Single model family only')
    report = add_pdf(run, 'hypotheses report.pdf', b'%PDF-1.4 report')
    rows = load_added(run)
    for row in rows:
        if row['paper_id'] == report['paper_id']:
            # chain order: deliberately not bank order, one unknown id dropped
            row['claim_ids'] = ['clm_p_two_0004', 'clm_p_one_0001', 'clm_nope_0001']
    _write_rows(run, rows)

    paper = load_paper(run, report['paper_id'])
    assert [c['id'] for c in paper['claims']] == ['clm_p_two_0004', 'clm_p_one_0001']
    assert paper['claim_count'] == 2
    assert paper['quote_count'] == 2

    cat = load_catalog(run)
    row = next(p for p in cat['papers'] if p['paper_id'] == report['paper_id'])
    assert row['claim_count'] == 2

    # papers without claim_ids keep their own claims untouched
    assert [c['id'] for c in load_paper(run, 'p_one')['claims']] == ['clm_p_one_0001', 'clm_p_one_0009']

def test_claim_context_returns_surrounding_source_text(tmp_path: Path) -> None:
    from lib.catalog import load_claim
    from lib.context import claim_context

    run = _write_run(tmp_path)
    page = ('Intro sentence one. ' * 30) + 'X is Y on the page. ' + ('Tail sentence. ' * 30)
    (run / 'cleaned_jsons' / 'p_one.json').write_text(
        json.dumps({'paper_id': 'p_one', 'pages': [{'page': 1, 'text': page}]}), encoding='utf-8')

    claim = load_claim(run, 'clm_p_one_0001')
    ctx = claim_context(run, claim)
    assert ctx['has_source_text'] is True
    quote = ctx['quotes'][0]
    assert quote['located'] is True
    assert quote['page'] == 1
    assert quote['text'] == 'X is Y on the page'
    assert quote['before'].endswith('Intro sentence one. ')
    assert quote['after'].startswith('. Tail sentence.')


def test_claim_context_degrades_without_converted_source(tmp_path: Path) -> None:
    from lib.catalog import load_claim
    from lib.context import claim_context

    run = _write_run(tmp_path)
    ctx = claim_context(run, load_claim(run, 'clm_p_one_0001'))
    assert ctx['has_source_text'] is False
    assert ctx['quotes'][0]['located'] is False
    assert ctx['quotes'][0]['text'] == 'X is Y on the page'
    assert ctx['quotes'][0]['before'] == ''


def test_load_claim_unknown_id_raises(tmp_path: Path) -> None:
    from lib.catalog import load_claim

    run = _write_run(tmp_path)
    with pytest.raises(KeyError):
        load_claim(run, 'clm_nope_9999')

def test_claim_anchors_paint_the_citing_clause_not_the_source_quote(tmp_path: Path) -> None:
    from lib.sources import _write_rows, add_pdf, load_added

    run = _write_run(tmp_path)
    report = add_pdf(run, 'review.pdf', b'%PDF-1.4 review')
    rows = load_added(run)
    for row in rows:
        if row['paper_id'] == report['paper_id']:
            row['claim_ids'] = ['clm_p_one_0001']
            row['claim_anchors'] = {'clm_p_one_0001': 'the clause as printed'}
    _write_rows(run, rows)

    claim = load_paper(run, report['paper_id'])['claims'][0]
    assert claim['anchor'] == 'the clause as printed'
    assert claim['quotes'][0]['text'] == 'X is Y on the page'  # banked quote survives

    # the source paper's own listing must not inherit the report's anchor
    assert 'anchor' not in load_paper(run, 'p_one')['claims'][0]
