"""Discover slash commands from Claude Code or Cursor, whichever launched us."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'crux-viewer' / 'scripts'
sys.path.insert(0, str(SCRIPTS))

from lib.slash_commands import (  # noqa: E402
    detect_host,
    filter_commands,
    list_commands,
    parse_frontmatter,
    parse_workflow_meta,
    slash_prefix,
)


def _write_skill(path: Path, name: str, description: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        f'---\nname: {name}\ndescription: >-\n  {description}\n---\n\n# {name}\n',
        encoding='utf-8',
    )


def _tree(tmp_path: Path) -> tuple[Path, Path]:
    project = tmp_path / 'proj'
    home = tmp_path / 'home'
    _write_skill(
        project / '.claude' / 'skills' / 'crux' / 'SKILL.md',
        'crux',
        'Hypothesis loop',
    )
    (project / '.claude' / 'skills' / 'crux' / 'workflows').mkdir(parents=True)
    (project / '.claude' / 'skills' / 'crux' / 'workflows' / 'crux-propose.js').write_text(
        "export const meta = {\n  name: 'crux-propose',\n  description: 'Draft proposals',\n}\n",
        encoding='utf-8',
    )
    (project / '.claude' / 'commands').mkdir(parents=True)
    (project / '.claude' / 'commands' / 'ship.md').write_text(
        '---\ndescription: Ship the branch\n---\n',
        encoding='utf-8',
    )
    (project / '.cursor' / 'commands').mkdir(parents=True)
    (project / '.cursor' / 'commands' / 'review.md').write_text(
        '# review\nReview the diff.\n',
        encoding='utf-8',
    )
    _write_skill(
        home / '.claude' / 'skills' / 'garment-layering' / 'SKILL.md',
        'garment-layering',
        'Assemble a simulated garment',
    )
    _write_skill(
        home / '.cursor' / 'skills-cursor' / 'create-skill' / 'SKILL.md',
        'create-skill',
        'Create Cursor Agent Skills',
    )
    _write_skill(
        home / '.cursor' / 'plugins' / 'cache' / 'pub' / 'hash' / 'skills' / 'hf-cli' / 'SKILL.md',
        'hf-cli',
        'Hugging Face Hub CLI',
    )
    return project, home


def test_detect_host_from_env_keys() -> None:
    assert detect_host({'CURSOR_TRACE_ID': 'abc'}) == 'cursor'
    assert detect_host({'CLAUDECODE': '1'}) == 'claude-code'
    assert detect_host({'CURSOR_TRACE_ID': 'x', 'CLAUDECODE': '1'}) == 'cursor'
    assert detect_host({}) == 'unknown'


def test_parse_frontmatter_folded_description() -> None:
    text = '---\nname: crux\ndescription: >-\n  Seeds then tournament\n---\n# hi\n'
    meta = parse_frontmatter(text)
    assert meta['name'] == 'crux'
    assert meta['description'] == 'Seeds then tournament'


def test_parse_workflow_meta() -> None:
    raw = "export const meta = {\n  name: 'crux-propose',\n  description: 'Draft proposals',\n}\n"
    meta = parse_workflow_meta(raw)
    assert meta == {'name': 'crux-propose', 'description': 'Draft proposals'}


def test_list_commands_cursor_includes_cursor_and_project_claude(tmp_path: Path) -> None:
    project, home = _tree(tmp_path)
    payload = list_commands(project, home=home, host='cursor')
    names = [row['name'] for row in payload['commands']]
    assert payload['host'] == 'cursor'
    assert '/crux' in names
    assert '/crux-propose' in names
    assert '/create-skill' in names
    assert '/hf-cli' in names
    assert '/review' in names
    assert '/ship' in names
    assert '/garment-layering' in names


def test_list_commands_claude_skips_cursor_trees(tmp_path: Path) -> None:
    project, home = _tree(tmp_path)
    names = [row['name'] for row in list_commands(project, home=home, host='claude-code')['commands']]
    assert '/crux' in names
    assert '/crux-propose' in names
    assert '/ship' in names
    assert '/garment-layering' in names
    assert '/create-skill' not in names
    assert '/review' not in names
    assert '/hf-cli' not in names


def test_user_skill_does_not_duplicate_project_name(tmp_path: Path) -> None:
    project, home = _tree(tmp_path)
    _write_skill(home / '.claude' / 'skills' / 'crux' / 'SKILL.md', 'crux', 'Old monolith')
    rows = list_commands(project, home=home, host='claude-code')['commands']
    crux = [row for row in rows if row['name'] == '/crux']
    assert len(crux) == 1
    assert crux[0]['description'] == 'Hypothesis loop'


def test_slash_prefix_only_when_composing_a_command() -> None:
    assert slash_prefix('/') == ''
    assert slash_prefix('/crux') == 'crux'
    assert slash_prefix('/crux ') is None
    assert slash_prefix('please /crux') is None
    assert slash_prefix('hello') is None


def test_filter_commands_matches_name_or_description() -> None:
    rows = [
        {'name': '/crux', 'description': 'Hypothesis loop'},
        {'name': '/crux-claims', 'description': 'Turn papers into claims'},
        {'name': '/create-skill', 'description': 'Author a Cursor skill'},
    ]
    assert [r['name'] for r in filter_commands(rows, 'crux')] == ['/crux', '/crux-claims']
    assert [r['name'] for r in filter_commands(rows, 'claim')] == ['/crux-claims']
    assert [r['name'] for r in filter_commands(rows, 'cursor')] == ['/create-skill']
    assert filter_commands(rows, '') == rows
