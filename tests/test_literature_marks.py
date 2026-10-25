"""Disk persistence for literature viewer user marks."""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'crux-viewer' / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from lib.marks import load_marks, parse_marks, save_marks  # noqa: E402

from test_literature_catalog import _write_run  # noqa: E402


def test_parse_marks_keeps_valid_and_drops_junk() -> None:
    marks = parse_marks(
        {
            'v': 1,
            'marks': [
                {
                    'id': 'a',
                    'type': 'highlight',
                    'page': 1,
                    'ink': 'yellow',
                    'start': 0,
                    'end': 8,
                },
                {
                    'id': 'b',
                    'type': 'box',
                    'page': 2,
                    'ink': 'mint',
                    'x1': 0,
                    'y1': 0,
                    'x2': 10,
                    'y2': 10,
                },
                {
                    'id': 'c',
                    'type': 'underline',
                    'page': 1,
                    'ink': 'finding',
                    'start': 0,
                    'end': 3,
                },
                {'id': 'd', 'type': 'highlight', 'page': 1, 'ink': 'sky', 'start': 4, 'end': 4},
                {'type': 'highlight', 'page': 1, 'ink': 'sky', 'start': 1, 'end': 2},
            ],
        }
    )
    assert len(marks) == 2
    assert marks[0]['id'] == 'a'
    assert marks[1]['type'] == 'box'


def test_save_and_load_marks_roundtrip(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    payload = {
        'v': 1,
        'marks': [
            {
                'id': 'um-1',
                'type': 'underline',
                'page': 1,
                'ink': 'pink',
                'start': 3,
                'end': 9,
            }
        ],
    }
    saved = save_marks(run, 'p_one', payload)
    path = run / 'literature_marks' / 'p_one.json'
    assert path.is_file()
    on_disk = json.loads(path.read_text(encoding='utf-8'))
    assert on_disk['marks'][0]['ink'] == 'pink'
    loaded = load_marks(run, 'p_one')
    assert loaded['marks'] == saved
    assert loaded['marks'][0]['start'] == 3


def test_load_marks_missing_file_is_empty(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    loaded = load_marks(run, 'p_one')
    assert loaded == {'v': 1, 'marks': []}


def test_save_marks_rejects_path_escape(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    with pytest.raises(ValueError):
        save_marks(run, '../outside', {'v': 1, 'marks': []})
