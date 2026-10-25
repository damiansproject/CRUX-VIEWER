"""Run the literature viewer mark helpers (Node)."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _node_tests(suite: Path) -> int:
    lines = suite.read_text(encoding='utf-8').splitlines()
    return sum(1 for line in lines if line.startswith('test('))


def test_user_marks_js_helpers() -> None:
    suite = ROOT / 'tests' / 'test_user_marks.mjs'
    node = shutil.which('node')
    if not node:
        pytest.skip(f'node not installed: {_node_tests(suite)} node tests in {suite.name} not run')
    subprocess.check_call(
        [node, '--test', str(suite)],
        cwd=ROOT,
    )
