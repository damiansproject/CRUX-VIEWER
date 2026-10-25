"""Independent extraction must preserve evidence and publish only complete results."""
from __future__ import annotations

import copy
import json
import threading
import urllib.error
from pathlib import Path

import pytest

from test_literature_pane_api import _get, _json_req, _server
from test_literature_catalog import _write_run


def test_extraction_status_available_without_chat_channel(tmp_path):
    run = _write_run(tmp_path)
    server, port = _server(run)
    try:
        result = _get(port, '/api/extraction/p_one')
        assert result['state'] == 'idle'
        assert result['claim_count'] == 1
        assert 'available' in result
    finally:
        server.shutdown()
        server.server_close()


def _result():
    return {'claims': [{'kind': 'finding', 'statement': 'X is Y.',
        'quotes': [{'text': 'X is Y on the page', 'locator': {'paper': 'p_one', 'page': 1}}],
        'attribution': {'basis': 'direct', 'rationale': None, 'references': []}}],
        'gist': 'A small source about X.'}


@pytest.mark.parametrize('wrong', ['quote', 'paper', 'reference', 'empty', 'kind'])
def test_invalid_model_evidence_cannot_reach_bank(wrong):
    from lib.extraction import validate_result
    result = _result()
    claim = result['claims'][0]
    if wrong == 'quote': claim['quotes'][0]['text'] = 'An invented result'
    if wrong == 'paper': claim['quotes'][0]['locator']['paper'] = 'other'
    if wrong == 'reference':
        claim['attribution']['references'] = [{'citation': '[1]', 'reference': {
            'text': 'Invented reference', 'locator': {'paper': 'p_one', 'page': 1}}}]
    if wrong == 'empty': result['claims'] = []
    if wrong == 'kind': claim['kind'] = 'guess'
    with pytest.raises(ValueError):
        validate_result(result, 'p_one', [{'page': 1, 'text': 'X is Y on the page'}])


def test_verified_result_keeps_attribution():
    from lib.extraction import validate_result
    result = _result()
    assert validate_result(copy.deepcopy(result), 'p_one', [
        {'page': 1, 'text': 'X is Y on the page'}])['claims'] == result['claims']


def test_failed_worker_keeps_bank_and_allows_retry(tmp_path, monkeypatch):
    from lib import extraction
    run = _write_run(tmp_path)
    original = (run / 'claims.jsonl').read_bytes()
    jobs = extraction.ExtractionJobs(run)
    monkeypatch.setattr(jobs, '_availability', lambda paper: (True, ''))
    def fail(*args):
        raise ValueError('Quote not found on its stated page.')
    monkeypatch.setattr(extraction, 'extract_paper', fail)
    status = jobs.start('p_one')
    jobs.thread.join(timeout=5)
    assert not jobs.thread.is_alive()
    assert jobs.status('p_one')['state'] == 'error'
    assert 'Quote' in jobs.status('p_one')['message']
    assert (run / 'claims.jsonl').read_bytes() == original
    assert jobs.start('p_one')['job_id'] != status['job_id']
    jobs.thread.join(timeout=5)


def test_duplicate_click_does_not_launch_second_worker(tmp_path, monkeypatch):
    from lib import extraction
    run = _write_run(tmp_path)
    entered, release = threading.Event(), threading.Event()
    jobs = extraction.ExtractionJobs(run)
    monkeypatch.setattr(jobs, '_availability', lambda paper: (True, ''))
    calls = []
    def work(*args):
        calls.append(args)
        entered.set()
        assert release.wait(5)
        return 3
    monkeypatch.setattr(extraction, 'extract_paper', work)
    first = jobs.start('p_one')
    assert entered.wait(5)
    try:
        assert jobs.start('p_one')['job_id'] == first['job_id']
        assert len(calls) == 1
    finally:
        release.set()
        jobs.thread.join(timeout=5)
    assert jobs.status('p_one')['state'] == 'complete'


def test_cli_has_no_tools_and_rejects_error_envelopes(tmp_path, monkeypatch):
    from lib import extraction
    calls = []
    monkeypatch.setattr(extraction.shutil, 'which', lambda name: 'claude.exe')
    def invoke(argv, **kwargs):
        calls.append((argv, kwargs))
        return type('Result', (), {'returncode': 1, 'stdout': json.dumps({
            'is_error': True, 'result': 'Usage limit reached'}), 'stderr': ''})()
    monkeypatch.setattr(extraction.subprocess, 'run', invoke)
    with pytest.raises(RuntimeError, match='Usage limit'):
        extraction.ask_model('source text', tmp_path, extraction.AgentConfig('claude', 'claude-sonnet-5'))
    argv, options = calls[0]
    assert argv[argv.index('--tools') + 1] == ''
    assert '--strict-mcp-config' in argv
    assert '--disable-slash-commands' in argv
    assert options['encoding'] == 'utf-8'
    assert options['input'] == 'source text'
    assert options['timeout'] <= 900


def test_reextract_replaces_only_selected_paper_and_saves_previous_bank(tmp_path):
    from lib.extraction import publish_claims
    run = _write_run(tmp_path)
    bank = run / 'claims.jsonl'
    old = json.loads(bank.read_text())
    other = {**old, 'paper_id': 'p_two', 'id': 'clm_p_two_0001'}
    bank.write_text(json.dumps(old) + '\n' + json.dumps(other) + '\n', encoding='utf-8')
    original = bank.read_bytes()
    new = {**old, 'id': 'clm_p_one_0002', 'statement': 'A newly extracted claim.'}
    work = run / 'job'
    work.mkdir()
    assert publish_claims(run, 'p_one', [old, other, new], original, work) == 1
    assert [json.loads(line) for line in bank.read_text().splitlines()] == [other, new]
    assert (work / 'previous-claims.jsonl').read_bytes() == original


def test_publication_conflict_preserves_external_changes(tmp_path):
    from lib.extraction import publish_claims
    run = _write_run(tmp_path)
    bank = run / 'claims.jsonl'
    original = bank.read_bytes()
    changed = original + b'\n'
    bank.write_bytes(changed)
    with pytest.raises(ValueError, match='changed during'):
        publish_claims(run, 'p_one', [], original, run)
    assert bank.read_bytes() == changed


def test_atomic_replace_failure_preserves_bank(tmp_path, monkeypatch):
    from lib import extraction
    run = _write_run(tmp_path)
    bank = run / 'claims.jsonl'
    original = bank.read_bytes()
    old = json.loads(original)
    new = {**old, 'id': 'clm_p_one_0002'}
    work = run / 'job'
    work.mkdir()
    def fail(*args):
        raise OSError('disk unavailable')
    monkeypatch.setattr(extraction.os, 'replace', fail)
    with pytest.raises(OSError):
        extraction.publish_claims(run, 'p_one', [old, new], original, work)
    assert bank.read_bytes() == original
    assert not list(run.glob('.claims-*.jsonl'))


def test_reextract_accepts_bank_without_final_newline(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from lib import extraction
    run = _write_run(tmp_path)
    bank = run / 'claims.jsonl'
    original = bank.read_bytes().rstrip(b'\r\n')
    bank.write_bytes(original)
    root = tmp_path / 'extractor'
    (root / 'prompts').mkdir(parents=True)
    (root / 'prompts/claim-extractor.md').write_text('Return supported claims.', encoding='utf-8')
    monkeypatch.setattr(extraction, 'extractor_root', lambda: root)
    monkeypatch.setattr(extraction, 'PdfReader', lambda path: SimpleNamespace(pages=[
        SimpleNamespace(extract_text=lambda: 'X is Y on the page')]))
    monkeypatch.setattr(extraction, 'ask_model', lambda *args: _result())
    new = {**json.loads(original), 'id': 'clm_p_one_0002'}
    def canonical_append(argv, **kwargs):
        assert '--append' in argv
        staged = Path(argv[argv.index('--out') + 1])
        # The real writer opens mode='a' and emits json.dumps(row) + '\n'.
        with staged.open('a', encoding='utf-8') as handle:
            handle.write(json.dumps(new) + '\n')
    monkeypatch.setattr(extraction.subprocess, 'run', canonical_append)
    work = run / 'job'
    work.mkdir()
    paper = extraction.load_paper(run, 'p_one')
    assert extraction.extract_paper(run, paper, work, lambda message: None) == 1
    assert json.loads(bank.read_text()) == new
    assert (work / 'previous-claims.jsonl').read_bytes() == original


def test_extractor_found_in_the_crux_folder_the_viewer_starts_in(tmp_path, monkeypatch):
    from lib import extraction
    skill = tmp_path / 'CRUX' / '.claude' / 'skills' / 'claim-extractor'
    (skill / 'scripts').mkdir(parents=True)
    (skill / 'prompts').mkdir()
    (skill / 'scripts' / 'write_claims.py').write_text('')
    (skill / 'prompts' / 'claim-extractor.md').write_text('')
    monkeypatch.delenv('CRUX_CLAIMS_ROOT', raising=False)
    monkeypatch.setattr(extraction, '__file__', str(tmp_path / 'plugin-cache' / 'lib' / 'extraction.py'))
    monkeypatch.chdir(tmp_path / 'CRUX')
    assert extraction.extractor_root() == skill


def test_claims_without_attribution_pass_as_the_claim_extractor_contract_returns_them():
    from lib.extraction import validate_result
    result = _result()
    del result['claims'][0]['attribution']
    assert validate_result(result, 'p_one', [{'page': 1, 'text': 'X is Y on the page'}])['claims']


def test_quote_cited_on_the_wrong_page_moves_to_the_page_that_holds_it():
    from lib.extraction import validate_result
    result = _result()
    result['claims'][0]['quotes'][0]['locator'].update(page=1, section='Intro')
    pages = [{'page': 1, 'text': 'Intro.'}, {'page': 2, 'text': 'X is Y on the page'}]
    assert validate_result(result, 'p_one', pages)['claims'][0]['quotes'][0]['locator'] == {'paper': 'p_one', 'page': 2}


def test_a_pdf_too_long_for_one_request_is_extracted_in_page_windows(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from lib import extraction
    run = _write_run(tmp_path)
    root = tmp_path / 'extractor'
    (root / 'prompts').mkdir(parents=True)
    (root / 'prompts/claim-extractor.md').write_text('Return supported claims.', encoding='utf-8')
    monkeypatch.setattr(extraction, 'extractor_root', lambda: root)
    filler = ' and more' * 27_000  # about 250,000 characters a page: three pages exceed one request
    texts = ['A binds B on page one' + filler, 'only references here' + filler, 'C blocks D on page three' + filler]
    monkeypatch.setattr(extraction, 'PdfReader', lambda path: SimpleNamespace(pages=[
        SimpleNamespace(extract_text=lambda text=text: text) for text in texts]))
    asked = []

    def window_reply(prompt, *args):
        source = json.loads(prompt[prompt.index('{"paper_id"'):])
        asked.append([page['page'] for page in source['pages']])
        claims = [{'kind': 'finding', 'statement': page['text'][:24], 'quotes': [
            {'text': page['text'][:24], 'locator': {'paper': 'p_one', 'page': page['page']}}]}
            for page in source['pages'] if 'on page' in page['text']]
        claims.append({'kind': 'finding', 'statement': 'The  same finding', 'quotes': [  # found in every window
            {'text': 'and more and more', 'locator': {'paper': 'p_one', 'page': source['pages'][0]['page']}}]})
        title = None if len(asked) == 1 else 'Binding'
        return {'claims': claims, 'gist': 'A source about binding.', 'title': title}
    monkeypatch.setattr(extraction, 'ask_model', window_reply)
    written = {}

    def writer(argv, **kwargs):
        written.update(json.loads(Path(argv[argv.index('--workflow_result') + 1]).read_text(encoding='utf-8')))
    monkeypatch.setattr(extraction.subprocess, 'run', writer)
    monkeypatch.setattr(extraction, 'publish_claims', lambda *args: 2)
    work = run / 'job'
    work.mkdir()
    paper = extraction.load_paper(run, 'p_one')
    assert extraction.extract_paper(run, paper, work, lambda message: None) == 2
    assert asked == [[1, 2], [3]]
    [result] = written['results']
    assert [claim['statement'] for claim in result['claims']] == [
        'A binds B on page one an', 'The  same finding', 'C blocks D on page three']
    assert [q['locator']['page'] for q in result['claims'][1]['quotes']] == [1, 3]
    assert (result['gist'], result['title']) == ('A source about binding.', 'Binding')
