"""Run every Node suite under tests/ that has no wrapper of its own."""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]


def _has_own_wrapper(suite: Path) -> bool:
    wrapper = suite.with_suffix('.py')
    return wrapper.is_file() and suite.name in wrapper.read_text(encoding='utf-8')


def _node_tests(suite: Path) -> int:
    lines = suite.read_text(encoding='utf-8').splitlines()
    return sum(1 for line in lines if line.startswith('test('))


SUITES = sorted(
    p.name for p in (ROOT / 'tests').glob('test_*.mjs') if not _has_own_wrapper(p)
)


@pytest.mark.parametrize('name', SUITES)
def test_node_suite(name: str) -> None:
    suite = ROOT / 'tests' / name
    node = shutil.which('node')
    if not node:
        pytest.skip(f'node not installed: {_node_tests(suite)} node tests in {name} not run')
    subprocess.check_call(
        [node, '--test', str(suite)],
        cwd=ROOT,
    )
