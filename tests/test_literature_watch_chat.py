"""watch_chat CLI used by the literature skill to poll the mailbox."""

from __future__ import annotations

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'crux-viewer' / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from lib.chat import append_message, watching  # noqa: E402
from test_literature_catalog import _write_run  # noqa: E402
from watch_chat import main  # noqa: E402


def test_watch_once_prints_pending_and_heartbeats(tmp_path: Path, capsys) -> None:
    run = _write_run(tmp_path)
    append_message(run, 'p_one', role='user', text='Summarize claim 0001')
    code = main(['--run', str(run), '--once'])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload['pending']['p_one']['text'] == 'Summarize claim 0001'
    assert watching(run) is True


def test_watch_once_prints_selected_span_attachments(tmp_path: Path, capsys) -> None:
    run = _write_run(tmp_path)
    append_message(
        run,
        'p_one',
        role='user',
        text='Explain this',
        attachments=[{'text': 'Fire frequency increased', 'page': 12}],
    )
    code = main(['--run', str(run), '--once'])
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload['pending']['p_one']['attachments'][0]['page'] == 12


def test_watch_reply_appends_assistant(tmp_path: Path, capsys) -> None:
    run = _write_run(tmp_path)
    user = append_message(run, 'p_one', role='user', text='hello')
    code = main(
        ['--run', str(run), '--reply', 'p_one', '--text', 'X is Y.', '--in-reply-to', user['id']]
    )
    assert code == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload['role'] == 'assistant'
    assert payload['text'] == 'X is Y.'
    assert payload['in_reply_to'] == user['id']
