"""PDF imports queue extraction without blocking uploads or replacing existing claims."""
import json
import threading
import urllib.error
import urllib.request

import pytest

from test_literature_pane_api import _get, _json_req, _server
from test_literature_catalog import _write_run
from lib import extraction
from lib.sources import add_pdf


def test_uploaded_pdfs_extract_serially_and_survive_a_failed_job(tmp_path, monkeypatch):
    run = _write_run(tmp_path)
    original = (run / 'claims.jsonl').read_bytes()
    entered, release, finished = threading.Event(), threading.Event(), threading.Event()
    calls = []
    monkeypatch.setattr(extraction.ExtractionJobs, '_availability', lambda *args: (True, ''))

    def work(run, paper, *args):
        calls.append(paper['paper_id'])
        if len(calls) == 1:
            entered.set()
            assert release.wait(5)
            raise ValueError('Recorded extraction failure')
        finished.set()
        return 2

    monkeypatch.setattr(extraction, 'extract_paper', work)
    server, port = _server(run)
    try:
        def upload(name):
            request = urllib.request.Request(f'http://127.0.0.1:{port}/api/sources?name={name}.pdf',
                data=b'%PDF-1.4 fixture', headers={'Content-Type': 'application/pdf'})
            return json.load(urllib.request.urlopen(request, timeout=5))
        first = upload('first')
        assert entered.wait(2), 'Adding a PDF did not start extraction'
        second = upload('second')
        queued = _get(port, f'/api/extraction/{second["paper_id"]}')
        assert queued['state'] == 'queued'
        assert calls == [first['paper_id']]
        release.set()
        assert finished.wait(5), 'A failed first job stranded the second PDF'
        server.RequestHandlerClass.extraction_jobs.thread.join(5)
        assert calls == [first['paper_id'], second['paper_id']]
        assert _get(port, f'/api/extraction/{first["paper_id"]}')['state'] == 'error'
        assert _get(port, f'/api/extraction/{second["paper_id"]}')['state'] == 'complete'
        assert (run / 'claims.jsonl').read_bytes() == original
    finally:
        release.set()
        server.shutdown()
        server.server_close()


def test_import_setup_failure_keeps_pdf_and_exposes_retry(tmp_path, monkeypatch):
    run = _write_run(tmp_path)
    monkeypatch.setattr(extraction.ExtractionJobs, '_availability',
                        lambda *args: (False, 'Install CRUX Claims, then retry.'))
    server, port = _server(run)
    try:
        request = urllib.request.Request(f'http://127.0.0.1:{port}/api/sources?name=new.pdf',
            data=b'%PDF-1.4 fixture', headers={'Content-Type': 'application/pdf'})
        row = json.load(urllib.request.urlopen(request, timeout=5))
        status = _get(port, f'/api/extraction/{row["paper_id"]}')
        assert status['state'] == 'error'
        assert 'Install CRUX Claims' in status['message']
        assert (run / row['source_pdf']).read_bytes() == b'%PDF-1.4 fixture'
    finally:
        server.shutdown()
        server.server_close()


def test_import_does_not_extract_banked_or_web_sources(tmp_path, monkeypatch):
    run = _write_run(tmp_path)
    jobs = extraction.ExtractionJobs(run)
    monkeypatch.setattr(jobs, 'start', lambda *args, **kwargs: pytest.fail('Unexpected extraction'))
    jobs.enqueue_missing('p_one')
    from lib.sources import add_url
    site = add_url(run, 'https://example.org/new')
    jobs.enqueue_missing(site['paper_id'])
    assert jobs.jobs == {}


def test_duplicate_queued_request_keeps_its_job(tmp_path, monkeypatch):
    run = _write_run(tmp_path)
    second = add_pdf(run, 'second.pdf', b'%PDF fixture')['paper_id']
    entered, release = threading.Event(), threading.Event()
    jobs = extraction.ExtractionJobs(run)
    monkeypatch.setattr(jobs, '_availability', lambda *args: (True, ''))
    calls = []
    def work(run, paper, *args):
        calls.append(paper['paper_id'])
        entered.set()
        assert release.wait(5)
        return 1
    monkeypatch.setattr(extraction, 'extract_paper', work)
    jobs.start('p_one')
    assert entered.wait(2)
    try:
        queued = jobs.enqueue_missing(second)
        assert jobs.enqueue_missing(second)['job_id'] == queued['job_id']
        assert jobs.start(second)['job_id'] == queued['job_id']
    finally:
        release.set()
        jobs.thread.join(5)
    assert calls == ['p_one', second]


def test_cross_origin_import_cannot_start_a_model(tmp_path, monkeypatch):
    run = _write_run(tmp_path)
    monkeypatch.setattr(extraction, 'extract_paper', lambda *args: pytest.fail('Foreign model request'))
    server, port = _server(run)
    try:
        request = urllib.request.Request(f'http://127.0.0.1:{port}/api/sources',
            data=b'%PDF fixture', headers={'Content-Type': 'application/pdf', 'Origin': 'https://example.org'})
        with pytest.raises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(request, timeout=5)
        assert error.value.code == 403
        assert not (run / 'literature_inbox').exists()
    finally:
        server.shutdown()
        server.server_close()


def test_retrieved_open_copy_also_extracts(tmp_path, monkeypatch):
    import serve_literature
    run = _write_run(tmp_path)
    entered = threading.Event()
    monkeypatch.setattr(serve_literature, 'grab',
                        lambda run, entry: add_pdf(run, 'retrieved.pdf', b'%PDF fixture'))
    monkeypatch.setattr(extraction.ExtractionJobs, '_availability', lambda *args: (True, ''))
    def work(*args):
        entered.set()
        return 1
    monkeypatch.setattr(extraction, 'extract_paper', work)
    server, port = _server(run)
    try:
        row = _json_req(port, '/api/grab', {'entry': 'Recorded reference'})
        assert entered.wait(2), 'Retrieved PDF did not start extraction'
        server.RequestHandlerClass.extraction_jobs.thread.join(5)
        assert _get(port, f'/api/extraction/{row["paper_id"]}')['state'] == 'complete'
    finally:
        server.shutdown()
        server.server_close()
