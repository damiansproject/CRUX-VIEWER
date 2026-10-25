from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any

INKS = frozenset({'yellow', 'mint', 'sky', 'pink', 'violet'})
PAPER_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]+$')
MARKS_DIR = 'literature_marks'


def parse_marks(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, dict) or not isinstance(raw.get('marks'), list):
        return []
    out: list[dict[str, Any]] = []
    for row in raw['marks']:
        mark = _parse_mark(row)
        if mark:
            out.append(mark)
    return out


def load_marks(run_dir: Path, paper_id: str) -> dict[str, Any]:
    path = _marks_path(run_dir, paper_id)
    if not path.is_file():
        return {'v': 1, 'marks': []}
    try:
        raw = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {'v': 1, 'marks': []}
    return {'v': 1, 'marks': parse_marks(raw)}


def save_marks(run_dir: Path, paper_id: str, payload: object) -> list[dict[str, Any]]:
    path = _marks_path(run_dir, paper_id)
    marks = parse_marks(payload if isinstance(payload, dict) else {})
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix('.json.tmp')
    tmp.write_text(
        json.dumps({'v': 1, 'marks': marks}, ensure_ascii=False, indent=2) + '\n',
        encoding='utf-8',
    )
    tmp.replace(path)
    return marks


def _marks_path(run_dir: Path, paper_id: str) -> Path:
    if not isinstance(paper_id, str) or not PAPER_ID_RE.match(paper_id):
        raise ValueError('invalid paper id')
    root = (Path(run_dir) / MARKS_DIR).resolve()
    path = (root / f'{paper_id}.json').resolve()
    path.relative_to(root)
    return path


def _parse_mark(row: object) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    mark_id = row.get('id')
    if not isinstance(mark_id, str) or not mark_id:
        return None
    page = row.get('page')
    if not isinstance(page, int) or isinstance(page, bool) or page < 1:
        return None
    ink = row.get('ink')
    if ink not in INKS:
        return None
    kind = row.get('type')
    if kind in ('highlight', 'underline'):
        span = _span(row.get('start'), row.get('end'))
        if not span:
            return None
        return {'id': mark_id, 'type': kind, 'page': page, 'ink': ink, **span}
    if kind == 'box':
        box = _box(row.get('x1'), row.get('y1'), row.get('x2'), row.get('y2'))
        if not box:
            return None
        return {'id': mark_id, 'type': 'box', 'page': page, 'ink': ink, **box}
    return None


def _span(start: object, end: object) -> dict[str, int] | None:
    try:
        a = round(float(start))  # type: ignore[arg-type]
        b = round(float(end))  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    if a == b:
        return None
    return {'start': a, 'end': b} if a < b else {'start': b, 'end': a}


def _box(x0: object, y0: object, x1: object, y1: object) -> dict[str, float] | None:
    try:
        xs = [float(x0), float(x1)]  # type: ignore[arg-type]
        ys = [float(y0), float(y1)]  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None
    left, right = min(xs), max(xs)
    top, bottom = min(ys), max(ys)
    if right - left < 1 or bottom - top < 1:
        return None
    return {'x1': left, 'y1': top, 'x2': right, 'y2': bottom}
