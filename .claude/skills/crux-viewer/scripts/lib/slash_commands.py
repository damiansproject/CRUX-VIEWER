from __future__ import annotations

import os
import re
from pathlib import Path
from typing import Any, Mapping

NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9:_-]*$')
META_BLOCK = re.compile(r'export\s+const\s+meta\s*=\s*\{(.*?)\}', re.S)
META_NAME = re.compile(r"""name:\s*['"]([^'"]+)['"]""")
META_DESC = re.compile(r"""description:\s*['"]([^'"]+)['"]""")


def detect_host(env: Mapping[str, str] | None = None) -> str:
    keys = {str(k).upper() for k in (os.environ if env is None else env)}
    cursor = any(k == 'CURSOR_TRACE_ID' or k.startswith('CURSOR_') for k in keys)
    claude = 'CLAUDECODE' in keys or any(k.startswith('CLAUDE_') for k in keys)
    if cursor:
        return 'cursor'
    if claude:
        return 'claude-code'
    return 'unknown'


def parse_frontmatter(text: str) -> dict[str, str]:
    if not text.startswith('---'):
        return {}
    end = text.find('\n---', 3)
    if end < 0:
        return {}
    block = text[3:end].strip('\n')
    out: dict[str, str] = {}
    key: str | None = None
    chunks: list[str] = []
    folded = False
    for line in block.splitlines():
        if key and (line.startswith('  ') or line.startswith('\t') or (folded and line.strip())):
            chunks.append(line.strip())
            continue
        if key:
            out[key] = ' '.join(c for c in chunks if c).strip()
            key = None
            chunks = []
            folded = False
        match = re.match(r'^([A-Za-z0-9_-]+):\s*(.*)$', line)
        if not match:
            continue
        key, raw = match.group(1), match.group(2).strip()
        if raw in ('>', '>-', '|', '|-'):
            chunks = []
            folded = True
            continue
        if raw:
            out[key] = raw.strip('\'"')
            key = None
        else:
            chunks = []
            folded = True
    if key:
        out[key] = ' '.join(c for c in chunks if c).strip()
    return {k: v for k, v in out.items() if v}


def parse_workflow_meta(text: str) -> dict[str, str]:
    block = META_BLOCK.search(text)
    if not block:
        return {}
    body = block.group(1)
    name = META_NAME.search(body)
    desc = META_DESC.search(body)
    out: dict[str, str] = {}
    if name:
        out['name'] = name.group(1).strip()
    if desc:
        out['description'] = desc.group(1).strip()
    return out


def slash_prefix(text: str) -> str | None:
    if not isinstance(text, str):
        return None
    line = text.split('\n')[-1]
    match = re.match(r'^/([^\s]*)$', line)
    if not match:
        return None
    return match.group(1)


def filter_commands(rows: list[dict[str, Any]], prefix: str) -> list[dict[str, Any]]:
    needle = (prefix or '').lower().lstrip('/')
    if not needle:
        return list(rows)
    out: list[dict[str, Any]] = []
    for row in rows:
        name = str(row.get('name') or '').lstrip('/').lower()
        desc = str(row.get('description') or '').lower()
        if needle in name or needle in desc:
            out.append(row)
    return out


def list_commands(
    project_root: Path | str,
    *,
    home: Path | str | None = None,
    host: str | None = None,
    env: Mapping[str, str] | None = None,
) -> dict[str, Any]:
    project = Path(project_root)
    home_dir = Path(home) if home is not None else Path.home()
    kind = host or detect_host(env)
    rows: list[dict[str, str]] = []
    seen: set[str] = set()

    def add(name: str, description: str, source: str) -> None:
        slug = name.strip().lstrip('/')
        if not NAME_RE.match(slug):
            return
        key = '/' + slug
        if key in seen:
            return
        seen.add(key)
        rows.append(
            {
                'name': key,
                'description': re.sub(r'\s+', ' ', description).strip()[:160],
                'source': source,
            }
        )

    for path, source in _skill_files(project, home_dir, kind):
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            continue
        meta = parse_frontmatter(text)
        add(meta.get('name') or path.parent.name, meta.get('description') or '', source)

    for path, source in _command_files(project, home_dir, kind):
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            continue
        meta = parse_frontmatter(text)
        desc = meta.get('description') or _first_prose(text) or path.stem.replace('-', ' ')
        add(meta.get('name') or path.stem, desc, source)

    for path, source in _workflow_files(project, home_dir, kind):
        try:
            text = path.read_text(encoding='utf-8')
        except OSError:
            continue
        meta = parse_workflow_meta(text)
        if not meta.get('name'):
            continue
        add(meta['name'], meta.get('description') or '', source)

    rows.sort(key=lambda row: row['name'].lstrip('/').lower())
    return {'host': kind, 'commands': rows}


def find_project_root(start: Path | str) -> Path:
    cur = Path(start).resolve()
    for path in (cur, *cur.parents):
        if (path / '.git').exists() or (path / '.claude' / 'skills').is_dir():
            return path
    return cur


def _skill_files(project: Path, home: Path, host: str) -> list[tuple[Path, str]]:
    roots: list[tuple[Path, str]] = [
        (project / '.claude' / 'skills', 'skill'),
        (project / '.agents' / 'skills', 'skill'),
    ]
    if host in ('cursor', 'unknown'):
        roots.append((project / '.cursor' / 'skills', 'skill'))
        roots.append((home / '.cursor' / 'skills-cursor', 'skill'))
        roots.append((home / '.cursor' / 'skills', 'skill'))
        roots.append((home / '.cursor' / 'plugins' / 'cache', 'skill'))
    if host in ('claude-code', 'cursor', 'unknown'):
        roots.append((home / '.claude' / 'skills', 'skill'))
        roots.append((home / '.claude' / 'plugins' / 'cache', 'skill'))
    return _unique_files(_expand_skills(roots))


def _command_files(project: Path, home: Path, host: str) -> list[tuple[Path, str]]:
    roots: list[tuple[Path, str]] = [(project / '.claude' / 'commands', 'command')]
    if host in ('cursor', 'unknown'):
        roots.append((project / '.cursor' / 'commands', 'command'))
        roots.append((home / '.cursor' / 'commands', 'command'))
    if host in ('claude-code', 'cursor', 'unknown'):
        roots.append((home / '.claude' / 'commands', 'command'))
    out: list[tuple[Path, str]] = []
    for root, source in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.glob('*.md')):
            if path.name.lower() == 'readme.md':
                continue
            out.append((path, source))
    return _unique_files(out)


def _workflow_files(project: Path, home: Path, host: str) -> list[tuple[Path, str]]:
    roots = [project / '.claude' / 'skills']
    if host in ('claude-code', 'unknown'):
        roots.append(home / '.claude' / 'skills')
    out: list[tuple[Path, str]] = []
    for root in roots:
        if not root.is_dir():
            continue
        for path in sorted(root.glob('*/workflows/*.js')):
            out.append((path, 'workflow'))
    return _unique_files(out)


def _expand_skills(roots: list[tuple[Path, str]]) -> list[tuple[Path, str]]:
    out: list[tuple[Path, str]] = []
    for root, source in roots:
        if not root.is_dir():
            continue
        found = list(root.glob('*/SKILL.md')) + list(root.glob('**/skills/*/SKILL.md'))
        for path in found:
            out.append((path, source))
    return out


def _unique_files(rows: list[tuple[Path, str]]) -> list[tuple[Path, str]]:
    seen: set[Path] = set()
    out: list[tuple[Path, str]] = []
    for path, source in rows:
        try:
            key = path.resolve()
        except OSError:
            continue
        if key in seen:
            continue
        seen.add(key)
        out.append((path, source))
    return out


def _first_prose(text: str) -> str:
    body = text
    if body.startswith('---'):
        end = body.find('\n---', 3)
        if end >= 0:
            body = body[end + 4 :]
    for line in body.splitlines():
        line = line.strip().lstrip('#').strip()
        if line:
            return line
    return ''
