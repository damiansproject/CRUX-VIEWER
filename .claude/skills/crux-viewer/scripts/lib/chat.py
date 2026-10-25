from __future__ import annotations

import base64
import binascii
import json
import re
import secrets
import time
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CHAT_DIR = 'literature_chat'
HEARTBEAT_SEC = 25
MAX_TEXT = 16_000
MAX_MESSAGES = 500
MAX_ATTACH = 8
MAX_ATTACH_TEXT = 4_000
MAX_IMAGE = 2_000_000
ROLES = frozenset({'user', 'assistant'})
PAPER_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]+$')
SPACE_RE = re.compile(r'\s+')
FILE_NAME_RE = re.compile(r'^[A-Za-z0-9_.-]+$')
PNG_MAGIC = b'\x89PNG\r\n\x1a\n'
CHAT_LOCK = threading.RLock()


def load_chat(run_dir: Path | str, paper_id: str) -> dict[str, Any]:
    path = _chat_path(run_dir, paper_id)
    if not path.is_file():
        return {'v': 1, 'messages': []}
    messages: list[dict[str, Any]] = []
    try:
        lines = path.read_text(encoding='utf-8').splitlines()
    except OSError:
        return {'v': 1, 'messages': []}
    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            continue
        parsed = _parse_message(row)
        if parsed:
            messages.append(parsed)
    return {'v': 1, 'messages': messages}


def append_message(
    run_dir: Path | str,
    paper_id: str,
    *,
    role: str,
    text: str,
    in_reply_to: str | None = None,
    attachments: object | None = None,
    context: dict[str, Any] | None = None,
    agent: str | None = None,
) -> dict[str, Any]:
    """Append a session message with source quotes and the reader's current context."""
    with CHAT_LOCK:
        return _append_message(run_dir, paper_id, role=role, text=text, in_reply_to=in_reply_to,
                               attachments=attachments, context=context, agent=agent)


def _append_message(run_dir, paper_id, *, role, text, in_reply_to, attachments, context, agent):
    if role not in ROLES:
        raise ValueError('role')
    body = text.strip() if isinstance(text, str) else ''
    existing = load_chat(run_dir, paper_id)['messages']
    if len(existing) >= MAX_MESSAGES:
        raise ValueError('too many messages')
    msg_id = f'm{len(existing) + 1:04d}_{secrets.token_hex(3)}'
    atts = _materialize_attachments(run_dir, paper_id, attachments, msg_id)
    if not body and not atts:
        raise ValueError('empty')
    quote_len = sum(len(row.get('text') or '') for row in atts)
    if len(body) + quote_len > MAX_TEXT:
        raise ValueError('too long')
    msg: dict[str, Any] = {
        'id': msg_id,
        'role': role,
        'text': body,
        'ts': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
    }
    if atts:
        msg['attachments'] = atts
    if role == 'assistant' and agent in {'Claude', 'Codex', 'Cursor'}:
        msg['agent'] = agent
    if isinstance(context, dict):
        msg['context'] = context
    if isinstance(in_reply_to, str) and in_reply_to.strip():
        msg['in_reply_to'] = in_reply_to.strip()
    path = _chat_path(run_dir, paper_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open('a', encoding='utf-8') as handle:
        handle.write(json.dumps(msg, ensure_ascii=False) + '\n')
    return msg


def pending_by_paper(run_dir: Path | str) -> dict[str, dict[str, Any]]:
    """Return each latest unanswered turn, including any earlier_messages to answer together."""
    root = Path(run_dir) / CHAT_DIR
    out: dict[str, dict[str, Any]] = {}
    if not root.is_dir():
        return out
    for path in sorted(root.glob('*.jsonl')):
        paper_id = path.stem
        if not PAPER_ID_RE.match(paper_id):
            continue
        messages = load_chat(run_dir, paper_id)['messages']
        pending: list[dict[str, Any]] = []
        for row in messages:
            if row['role'] == 'user':
                pending.append(row)
            elif not row.get('in_reply_to'):
                pending = []  # Legacy replies acknowledge everything read so far.
            else:
                for i, question in enumerate(pending):
                    if question['id'] == row['in_reply_to']:
                        pending = pending[i + 1:]
                        break
        if pending:
            out[paper_id] = dict(pending[-1])
            if len(pending) > 1:
                out[paper_id]['earlier_messages'] = pending[:-1]
    return out


def touch_session(run_dir: Path | str, pending: dict[str, dict[str, Any]] | None = None) -> dict[str, Any]:
    """Refresh the heartbeat; mark only messages picked up by a one-shot session poll."""
    path = Path(run_dir) / CHAT_DIR / '_session.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {'watching': True, 'ts': time.time()}
    if pending:
        payload['responding'] = {paper_id: row['id'] for paper_id, row in pending.items()}
    path.write_text(json.dumps(payload) + '\n', encoding='utf-8')
    return payload


def watching(run_dir: Path | str) -> bool:
    """Whether the session has checked in within the heartbeat window."""
    return bool(_session_state(run_dir))


def responding_to(run_dir: Path | str, paper_id: str) -> str | None:
    """Return the picked-up message ID while its session heartbeat is fresh."""
    return _session_state(run_dir).get('responding', {}).get(paper_id)


def _session_state(run_dir: Path | str) -> dict[str, Any]:
    path = Path(run_dir) / CHAT_DIR / '_session.json'
    if not path.is_file():
        return {}
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return {}
    try:
        ts = float(data.get('ts'))
    except (TypeError, ValueError):
        return {}
    return data if (time.time() - ts) <= HEARTBEAT_SEC else {}


def read_chat_file(run_dir: Path | str, paper_id: str, name: str) -> tuple[bytes, str]:
    if not isinstance(name, str) or not FILE_NAME_RE.match(name):
        raise ValueError('file')
    folder = _files_dir(run_dir, paper_id)
    path = (folder / name).resolve()
    path.relative_to(folder)
    if not path.is_file():
        raise FileNotFoundError('file')
    return path.read_bytes(), 'image/png'


def _chat_path(run_dir: Path | str, paper_id: str) -> Path:
    if not isinstance(paper_id, str) or not PAPER_ID_RE.match(paper_id):
        raise ValueError('invalid paper id')
    root = (Path(run_dir) / CHAT_DIR).resolve()
    path = (root / f'{paper_id}.jsonl').resolve()
    path.relative_to(root)
    return path


def _parse_message(row: object) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    msg_id = row.get('id')
    role = row.get('role')
    text = row.get('text')
    if not isinstance(msg_id, str) or not msg_id:
        return None
    if role not in ROLES:
        return None
    if not isinstance(text, str):
        return None
    atts = _parse_attachments(row.get('attachments'))
    body = text.strip()
    if not body and not atts:
        return None
    out: dict[str, Any] = {
        'id': msg_id,
        'role': role,
        'text': body,
        'ts': row.get('ts') if isinstance(row.get('ts'), str) else '',
    }
    if atts:
        out['attachments'] = atts
    if role == 'assistant' and row.get('agent') in {'Claude', 'Codex', 'Cursor'}:
        out['agent'] = row['agent']
    if isinstance(row.get('context'), dict):
        out['context'] = row['context']
    reply = row.get('in_reply_to')
    if isinstance(reply, str) and reply.strip():
        out['in_reply_to'] = reply.strip()
    return out


def _parse_attachments(raw: object) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    for row in raw:
        parsed = _parse_one_attachment(row)
        if parsed:
            out.append(parsed)
        if len(out) >= MAX_ATTACH:
            break
    return out


def _parse_one_attachment(row: object) -> dict[str, Any] | None:
    if not isinstance(row, dict):
        return None
    if row.get('type') == 'image':
        return _parse_image_ref(row)
    text = row.get('text')
    if not isinstance(text, str):
        return None
    body = SPACE_RE.sub(' ', text).strip()
    if not body:
        return None
    item: dict[str, Any] = {'text': body[:MAX_ATTACH_TEXT]}
    source = row.get('paper_id')
    if isinstance(source, str) and PAPER_ID_RE.fullmatch(source):
        item['paper_id'] = source
    page = row.get('page')
    if isinstance(page, int) and not isinstance(page, bool) and page >= 1:
        item['page'] = page
    return item


def _parse_image_ref(row: dict[str, Any]) -> dict[str, Any] | None:
    file = row.get('file')
    if not isinstance(file, str) or not file.strip() or '..' in file:
        return None
    item: dict[str, Any] = {'type': 'image', 'file': file.strip()}
    name = row.get('name')
    if isinstance(name, str) and FILE_NAME_RE.match(name):
        item['name'] = name
    else:
        item['name'] = Path(file).name
    source = row.get('paper_id')
    if isinstance(source, str) and PAPER_ID_RE.fullmatch(source):
        item['paper_id'] = source
    page = row.get('page')
    if isinstance(page, int) and not isinstance(page, bool) and page >= 1:
        item['page'] = page
    return item


def _materialize_attachments(
    run_dir: Path | str,
    paper_id: str,
    raw: object,
    msg_id: str,
) -> list[dict[str, Any]]:
    if not isinstance(raw, list):
        return []
    out: list[dict[str, Any]] = []
    img_i = 0
    for row in raw:
        if not isinstance(row, dict):
            continue
        if row.get('type') == 'image':
            data, ext = _decode_image(row)
            img_i += 1
            name = f'{msg_id}_{img_i}.{ext}'
            dest = _files_dir(run_dir, paper_id) / name
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            item: dict[str, Any] = {
                'type': 'image',
                'file': f'{CHAT_DIR}/{paper_id}_files/{name}',
                'name': name,
            }
            source = row.get('paper_id')
            if isinstance(source, str) and PAPER_ID_RE.fullmatch(source):
                item['paper_id'] = source
            page = row.get('page')
            if isinstance(page, int) and not isinstance(page, bool) and page >= 1:
                item['page'] = page
            out.append(item)
        else:
            parsed = _parse_one_attachment(row)
            if parsed:
                out.append(parsed)
        if len(out) >= MAX_ATTACH:
            break
    return out


def _decode_image(row: dict[str, Any]) -> tuple[bytes, str]:
    raw = row.get('data')
    if not isinstance(raw, str) or not raw.strip():
        raise ValueError('image')
    payload = raw.strip()
    if payload.startswith('data:'):
        _, _, payload = payload.partition(',')
    try:
        data = base64.b64decode(payload, validate=False)
    except (ValueError, binascii.Error) as exc:
        raise ValueError('image') from exc
    if not data:
        raise ValueError('image')
    if len(data) > MAX_IMAGE:
        raise ValueError('too long')
    if not data.startswith(PNG_MAGIC):
        raise ValueError('image')
    return data, 'png'


def _files_dir(run_dir: Path | str, paper_id: str) -> Path:
    if not isinstance(paper_id, str) or not PAPER_ID_RE.match(paper_id):
        raise ValueError('invalid paper id')
    root = (Path(run_dir) / CHAT_DIR).resolve()
    path = (root / f'{paper_id}_files').resolve()
    path.relative_to(root)
    return path
