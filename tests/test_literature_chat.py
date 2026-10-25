"""Literature chat mailbox — same session that launched the viewer."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'crux-viewer' / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from lib.chat import (  # noqa: E402
    HEARTBEAT_SEC,
    append_message,
    load_chat,
    pending_by_paper,
    touch_session,
    watching,
)
from test_literature_catalog import _write_run  # noqa: E402


def test_append_user_then_assistant_roundtrip(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    user = append_message(run, 'p_one', role='user', text='What is the main claim?')
    assert user['role'] == 'user'
    assert user['text'] == 'What is the main claim?'
    assert user['id']
    path = run / 'literature_chat' / 'p_one.jsonl'
    assert path.is_file()
    reply = append_message(
        run,
        'p_one',
        role='assistant',
        text='X is Y, from claim 0001.',
        in_reply_to=user['id'],
    )
    chat = load_chat(run, 'p_one')
    assert [m['role'] for m in chat['messages']] == ['user', 'assistant']
    assert chat['messages'][1]['in_reply_to'] == user['id']
    assert reply['id'] != user['id']


def test_pending_is_the_last_unanswered_user_turn(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    append_message(run, 'p_one', role='user', text='first')
    append_message(run, 'p_one', role='assistant', text='ok')
    later = append_message(run, 'p_one', role='user', text='and then?')
    pending = pending_by_paper(run)
    assert list(pending) == ['p_one']
    assert pending['p_one']['id'] == later['id']
    assert pending['p_one']['text'] == 'and then?'


def test_no_pending_after_assistant_reply(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    append_message(run, 'p_one', role='user', text='hi')
    append_message(run, 'p_one', role='assistant', text='hello')
    assert pending_by_paper(run) == {}


def test_rejects_empty_and_oversized_text(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    with pytest.raises(ValueError, match='empty'):
        append_message(run, 'p_one', role='user', text='   ')
    with pytest.raises(ValueError, match='too long'):
        append_message(run, 'p_one', role='user', text='x' * 20_000)
    with pytest.raises(ValueError, match='role'):
        append_message(run, 'p_one', role='system', text='nope')


def test_user_can_send_selected_text_as_attachments(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    msg = append_message(
        run,
        'p_one',
        role='user',
        text='Why this sentence?',
        attachments=[{'text': 'Fire frequency increased', 'page': 12}, {'text': '   '}],
    )
    assert msg['attachments'] == [{'text': 'Fire frequency increased', 'page': 12}]
    loaded = load_chat(run, 'p_one')['messages'][0]
    assert loaded['attachments'][0]['page'] == 12
    pending = pending_by_paper(run)
    assert pending['p_one']['attachments'][0]['text'] == 'Fire frequency increased'


def test_attachment_alone_is_a_message(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    msg = append_message(
        run,
        'p_one',
        role='user',
        text='  ',
        attachments=[{'text': 'selected span', 'page': 3}],
    )
    assert msg['text'] == ''
    assert msg['attachments'][0]['text'] == 'selected span'
    loaded = load_chat(run, 'p_one')['messages'][0]
    assert loaded['text'] == ''
    assert loaded['attachments'][0]['page'] == 3


def test_image_attachment_is_written_beside_the_mailbox(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    png = (
        b'\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01'
        b'\x08\x06\x00\x00\x00\x1f\x15\xc4\x89\x00\x00\x00\nIDATx\x9cc\x00\x01'
        b'\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82'
    )
    import base64

    msg = append_message(
        run,
        'p_one',
        role='user',
        text='',
        attachments=[{'type': 'image', 'page': 4, 'data': base64.b64encode(png).decode('ascii')}],
    )
    att = msg['attachments'][0]
    assert att['type'] == 'image'
    assert att['page'] == 4
    assert 'data' not in att
    stored = run / att['file']
    assert stored.is_file()
    assert stored.read_bytes().startswith(b'\x89PNG')
    pending = pending_by_paper(run)
    assert pending['p_one']['attachments'][0]['file'] == att['file']


def test_heartbeat_watching_window(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    run = _write_run(tmp_path)
    assert watching(run) is False
    monkeypatch.setattr('lib.chat.time.time', lambda: 1_000.0)
    touch_session(run)
    assert watching(run) is True
    monkeypatch.setattr('lib.chat.time.time', lambda: 1_000.0 + HEARTBEAT_SEC + 1)
    assert watching(run) is False
    session = json.loads((run / 'literature_chat' / '_session.json').read_text(encoding='utf-8'))
    assert session['watching'] is True
