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

from serve_literature import bind_server, make_handler  # noqa: E402

from test_literature_catalog import _write_run  # noqa: E402
from test_literature_pane_api import _server  # noqa: E402


def test_api_catalog_and_paper(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    httpd, port = bind_server(make_handler(run), 18000)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        catalog = json.loads(
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/catalog', timeout=5).read()
        )
        assert catalog['papers'][0]['paper_id'] == 'p_one'
        paper = json.loads(
            urllib.request.urlopen(
                f'http://127.0.0.1:{port}/api/paper/p_one', timeout=5
            ).read()
        )
        assert paper['claims'][0]['id'] == 'clm_p_one_0001'
        home = urllib.request.urlopen(f'http://127.0.0.1:{port}/', timeout=5).read()
        assert b'Literature' in home
        view = urllib.request.urlopen(f'http://127.0.0.1:{port}/view/p_one', timeout=5).read()
        assert b'id="tool-highlight"' in view
        assert b'id="tool-box"' in view
        assert b'id="tab-info"' in view
        assert b'id="tab-claims"' in view
        assert b'id="tab-chat"' in view
        assert b'id="info-pane"' in view
        marks_js = urllib.request.urlopen(
            f'http://127.0.0.1:{port}/static/user_marks.mjs', timeout=5
        ).read()
        assert b'export const INKS' in marks_js
        empty = json.loads(
            urllib.request.urlopen(
                f'http://127.0.0.1:{port}/api/marks/p_one', timeout=5
            ).read()
        )
        assert empty == {'v': 1, 'marks': []}
        payload = {
            'v': 1,
            'marks': [
                {
                    'id': 'um-disk',
                    'type': 'highlight',
                    'page': 1,
                    'ink': 'sky',
                    'start': 2,
                    'end': 11,
                }
            ],
        }
        req = urllib.request.Request(
            f'http://127.0.0.1:{port}/api/marks/p_one',
            data=json.dumps(payload).encode('utf-8'),
            method='PUT',
            headers={'Content-Type': 'application/json'},
        )
        saved = json.loads(urllib.request.urlopen(req, timeout=5).read())
        assert saved['marks'][0]['ink'] == 'sky'
        on_disk = json.loads(
            (run / 'literature_marks' / 'p_one.json').read_text(encoding='utf-8')
        )
        assert on_disk['marks'][0]['id'] == 'um-disk'
        again = json.loads(
            urllib.request.urlopen(
                f'http://127.0.0.1:{port}/api/marks/p_one', timeout=5
            ).read()
        )
        assert again['marks'][0]['start'] == 2
        pdf_req = urllib.request.Request(
            f'http://127.0.0.1:{port}/api/sources',
            data=b'%PDF-1.4 added',
            method='POST',
            headers={'Content-Type': 'application/pdf', 'X-Filename': 'Notes.pdf'},
        )
        added = json.loads(urllib.request.urlopen(pdf_req, timeout=5).read())
        assert added['origin'] == 'pdf'
        req = urllib.request.Request(
            f'http://127.0.0.1:{port}/api/sources',
            data=json.dumps({'url': 'https://example.org/live'}).encode('utf-8'),
            method='POST',
            headers={'Content-Type': 'application/json'},
        )
        site = json.loads(urllib.request.urlopen(req, timeout=5).read())
        catalog = json.loads(
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/catalog', timeout=5).read()
        )
        ids = [p['paper_id'] for p in catalog['papers']]
        assert added['paper_id'] in ids
        assert site['paper_id'] in ids
        extra = json.loads(
            urllib.request.urlopen(
                f'http://127.0.0.1:{port}/api/paper/{added["paper_id"]}', timeout=5
            ).read()
        )
        assert extra['claims'] == []
        boundary = '----CruxForm'
        form = (
            f'--{boundary}\r\n'
            'Content-Disposition: form-data; name="file"; filename="Scan.pdf"\r\n'
            'Content-Type: application/pdf\r\n'
            '\r\n'
            '%PDF-1.4 form\r\n'
            f'--{boundary}--\r\n'
        ).encode('ascii')
        form_req = urllib.request.Request(
            f'http://127.0.0.1:{port}/api/sources',
            data=form,
            method='POST',
            headers={'Content-Type': f'multipart/form-data; boundary={boundary}'},
        )
        uploaded = json.loads(urllib.request.urlopen(form_req, timeout=5).read())
        assert uploaded['paper_id'] == 'Scan'
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_api_claim_returns_context_and_portal_flag(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    page = 'Lead in text. X is Y on the page. Trailing text.'
    (run / 'cleaned_jsons' / 'p_one.json').write_text(
        json.dumps({'paper_id': 'p_one', 'pages': [{'page': 1, 'text': page}]}), encoding='utf-8')
    httpd, port = bind_server(make_handler(run), 18040)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        payload = json.loads(urllib.request.urlopen(
            f'http://127.0.0.1:{port}/api/claim/clm_p_one_0001', timeout=5).read())
        assert payload['paper_id'] == 'p_one'
        assert payload['source_in_catalog'] is True
        quote = payload['quotes'][0]
        assert quote['located'] is True
        assert quote['before'] == 'Lead in text. '
        assert quote['after'].startswith('. Trailing')
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/claim/clm_nope', timeout=5)
            raise AssertionError('unknown claim should 404')
        except urllib.error.HTTPError as exc:
            assert exc.code == 404
    finally:
        httpd.shutdown()
        thread.join(timeout=5)


def _status(port: int, method: str, path: str, headers: dict) -> tuple[int, dict]:
    req = urllib.request.Request(f'http://127.0.0.1:{port}{path}', data=b'{}' if method != 'GET' else None,
                                 method=method, headers={'Content-Type': 'application/json', **headers})
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, dict(resp.headers)
    except urllib.error.HTTPError as error:
        return error.code, dict(error.headers)


@pytest.mark.parametrize('method, path, headers', [
    ('GET', '/api/catalog', {'Host': 'rebound.example:80'}),
    ('PUT', '/api/marks/p_one', {'Origin': 'https://example.com'}),
    ('POST', '/api/locate', {'Origin': 'https://example.com'}),
    ('POST', '/api/extraction/p_one', {'Origin': 'https://example.com'}),
])
def test_requests_from_other_sites_are_refused(tmp_path: Path, method, path, headers) -> None:
    run = _write_run(tmp_path)
    httpd, port = _server(run)
    try:
        assert _status(port, method, path, headers)[0] == 403
        assert _status(port, 'GET', '/api/catalog', {})[0] == 200
        assert 'Access-Control-Allow-Origin' not in _status(port, 'GET', '/api/catalog', {})[1]
        assert not (run / 'literature_extract').exists()
    finally:
        httpd.shutdown()
        httpd.server_close()


@pytest.mark.parametrize('failure', [urllib.error.HTTPError('u', 403, 'Forbidden', {}, None), TimeoutError()])
def test_proxy_refuses_non_web_urls_and_falls_back_to_stored_text(tmp_path: Path, monkeypatch, failure) -> None:
    import serve_literature
    run = _write_run(tmp_path, web=True)
    (run / 'cleaned_jsons' / 'p_one.json').write_text(json.dumps({'pages': [{'page': 1, 'text': 'X is Y on the page'}]}))
    with pytest.raises(ValueError):
        serve_literature._fetch_live((run / 'claims.jsonl').as_uri())

    def challenge(url):
        raise failure
    monkeypatch.setattr(serve_literature, '_fetch_live', challenge)
    httpd, port = _server(run)
    try:
        page = urllib.request.urlopen(f'http://127.0.0.1:{port}/proxy/p_one', timeout=5).read().decode('utf-8')
        assert 'X is Y on the page' in page and 'https://example.org/article' in page
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_pdf_documents_open_without_eval() -> None:
    viewer = Path(__file__).resolve().parents[1] / '.claude/skills/crux-viewer/scripts/viewer'
    calls = [line for f in viewer.glob('*.*js') for line in f.read_text(encoding='utf-8').splitlines() if 'getDocument(' in line]
    assert calls and all('isEvalSupported: false' in line for line in calls)


def test_proxy_redirects_stay_on_the_web(monkeypatch) -> None:
    import http.server
    import serve_literature

    class Redirect(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(302)
            self.send_header('Location', 'ftp://127.0.0.1:9/x')
            self.end_headers()

        def log_message(self, *args):
            pass
    ftp_calls = []
    monkeypatch.setattr(urllib.request.FTPHandler, 'ftp_open', lambda self, req: ftp_calls.append(req.full_url))
    httpd = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Redirect)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        with pytest.raises(urllib.error.URLError):
            serve_literature._fetch_live(f'http://127.0.0.1:{httpd.server_port}/')
        assert ftp_calls == []
    finally:
        httpd.shutdown()
        httpd.server_close()
