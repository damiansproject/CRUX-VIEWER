"""HTTP API for literature info + chat panes."""

from __future__ import annotations

import json
import sys
import threading
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'crux-viewer' / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from serve_literature import bind_server, make_handler  # noqa: E402
from test_literature_catalog import _write_run  # noqa: E402


def _server(run: Path, project_root: Path | None = None):
    httpd, port = bind_server(make_handler(run, project_root=project_root), 18100)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    return httpd, port


def _get(port: int, path: str) -> object:
    return json.loads(urllib.request.urlopen(f'http://127.0.0.1:{port}{path}', timeout=5).read())


def _json_req(port: int, path: str, payload: dict, method: str = 'POST') -> object:
    req = urllib.request.Request(
        f'http://127.0.0.1:{port}{path}',
        data=json.dumps(payload).encode('utf-8'),
        method=method,
        headers={'Content-Type': 'application/json'},
    )
    return json.loads(urllib.request.urlopen(req, timeout=5).read())


def test_info_get_and_overlay_put(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    httpd, port = _server(run)
    try:
        info = _get(port, '/api/info/p_one')
        assert info['paper_id'] == 'p_one'
        assert info['title'] == 'Example Paper'
        assert info['can_get_pdf'] is True
        saved = _json_req(
            port,
            '/api/info/p_one',
            {'authors': 'Hopkins J', 'year': 2025, 'pmid': '40186548'},
            method='PUT',
        )
        assert saved['authors'] == 'Hopkins J'
        assert saved['year'] == 2025
        again = _get(port, '/api/info/p_one')
        assert again['pmid'] == '40186548'
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_info_resolve_doi(tmp_path: Path, monkeypatch) -> None:
    from lib import paper_info

    payload = {
        'message': {
            'title': ['Fire Frequency'],
            'author': [{'family': 'Hopkins', 'given': 'J'}],
            'container-title': ['Molecular Ecology'],
            'published-print': {'date-parts': [[2025, 5, 1]]},
            'DOI': '10.1111/mec.17756',
        }
    }

    def fake_fetch(url: str, timeout: int = 20) -> bytes:
        assert '10.1111/mec.17756' in url.lower()
        return json.dumps(payload).encode('utf-8')

    monkeypatch.setattr(paper_info, 'default_fetch', fake_fetch)
    run = _write_run(tmp_path)
    httpd, port = _server(run)
    try:
        _json_req(port, '/api/info/p_one', {'doi': '10.1111/mec.17756'}, method='PUT')
        resolved = _json_req(port, '/api/info/p_one/resolve', {'from': 'doi'})
        assert resolved['journal'] == 'Molecular Ecology'
        assert resolved['authors'] == 'Hopkins J'
        assert resolved['year'] == 2025
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_chat_post_get_and_assistant_reply(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    httpd, port = _server(run)
    try:
        empty = _get(port, '/api/chat/p_one')
        assert empty['messages'] == []
        assert empty['watching'] is False
        posted = _json_req(port, '/api/chat/p_one', {'text': 'What is the finding?'})
        assert posted['role'] == 'user'
        chat = _get(port, '/api/chat/p_one')
        assert chat['messages'][0]['text'] == 'What is the finding?'
        reply = _json_req(
            port,
            '/api/chat/p_one',
            {'text': 'X is Y.', 'role': 'assistant', 'in_reply_to': posted['id']},
        )
        assert reply['role'] == 'assistant'
        chat = _get(port, '/api/chat/p_one')
        assert [m['role'] for m in chat['messages']] == ['user', 'assistant']
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_chat_post_keeps_selected_span_attachments(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    httpd, port = _server(run)
    try:
        quoted = _json_req(
            port,
            '/api/chat/p_one',
            {'text': '', 'attachments': [{'text': 'Fire frequency', 'page': 4}]},
        )
        assert quoted['attachments'][0]['page'] == 4
        chat = _get(port, '/api/chat/p_one')
        assert chat['messages'][0]['attachments'][0]['text'] == 'Fire frequency'
        view = urllib.request.urlopen(f'http://127.0.0.1:{port}/view/p_one', timeout=5).read()
        reader = urllib.request.urlopen(f'http://127.0.0.1:{port}/reader/p_one', timeout=5).read()
        assert b'id="sel-menu"' in reader
        assert b'id="chat-attach"' in view
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_chat_image_attachment_is_served(tmp_path: Path) -> None:
    import base64

    run = _write_run(tmp_path)
    png = base64.b64decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    )
    httpd, port = _server(run)
    try:
        posted = _json_req(
            port,
            '/api/chat/p_one',
            {
                'text': '',
                'attachments': [{'type': 'image', 'page': 2, 'data': base64.b64encode(png).decode('ascii')}],
            },
        )
        name = posted['attachments'][0]['name']
        with urllib.request.urlopen(
            f'http://127.0.0.1:{port}/api/chat/p_one/file/{name}', timeout=5
        ) as resp:
            assert resp.headers.get_content_type() == 'image/png'
            assert resp.read().startswith(b'\x89PNG')
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_pdf_download_disposition(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    httpd, port = _server(run)
    try:
        req = urllib.request.Request(f'http://127.0.0.1:{port}/pdf/p_one?download=1')
        with urllib.request.urlopen(req, timeout=5) as resp:
            disp = resp.headers.get('Content-Disposition') or ''
            assert 'attachment' in disp
            assert resp.headers.get_content_type() == 'application/pdf'
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_api_commands_lists_project_skills(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    project = tmp_path / 'proj'
    skill = project / '.claude' / 'skills' / 'demo'
    skill.mkdir(parents=True)
    (skill / 'SKILL.md').write_text(
        '---\nname: demo-skill\ndescription: A demo command\n---\n',
        encoding='utf-8',
    )
    httpd, port = _server(run, project_root=project)
    try:
        payload = _get(port, '/api/commands')
        names = [row['name'] for row in payload['commands']]
        assert '/demo-skill' in names
        assert payload['host'] in {'cursor', 'claude-code', 'unknown'}
        view = urllib.request.urlopen(f'http://127.0.0.1:{port}/view/p_one', timeout=5).read()
        assert b'id="chat-slash"' in view
        assert b'chat-compose' in view
    finally:
        httpd.shutdown()
        httpd.server_close()
