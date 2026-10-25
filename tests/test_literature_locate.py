"""Model-assisted citation portals: locate a passage, resolve a citation."""
from __future__ import annotations

import json
import sys
import threading
import urllib.error
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'crux-viewer' / 'scripts'
sys.path.insert(0, str(SCRIPTS))

import serve_literature  # noqa: E402
from lib.locate import (  # noqa: E402
    LocateUnavailable,
    build_prompt,
    build_resolve_prompt,
    clean_pages,
    locate,
    parse_reply,
    parse_resolve_reply,
    resolve_cite,
)
from serve_literature import bind_server, make_handler  # noqa: E402

from test_literature_catalog import _write_run  # noqa: E402

QUOTE = 'steering vectors control model behavior at inference time'


def test_parse_reply_accepts_passages_with_or_without_fences() -> None:
    multi = (
        '```json\n{"passages": [{"page": 3, "quote": "%s"}, '
        '{"page": 5, "quote": "a second verbatim passage of decent length"}]}\n```'
    ) % QUOTE
    assert parse_reply(multi) == [
        {'page': 3, 'quote': QUOTE},
        {'page': 5, 'quote': 'a second verbatim passage of decent length'},
    ]
    # legacy single-object replies still count
    assert parse_reply('{"page": 3, "quote": "%s"}' % QUOTE) == [{'page': 3, 'quote': QUOTE}]
    assert parse_reply('{"passages": [{"page": 3, "quote": "a  spaced\\n quote of length"}]}') == [
        {'page': 3, 'quote': 'a spaced quote of length'}
    ]


def test_parse_reply_rejects_misses_junk_and_caps_at_three() -> None:
    assert parse_reply('{"passages": []}') == []
    assert parse_reply('{"page": 0, "quote": ""}') == []
    assert parse_reply('{"passages": [{"page": 2, "quote": "short"}]}') == []
    assert parse_reply('no json here') == []
    assert parse_reply('') == []
    many = json.dumps(
        {'passages': [{'page': n, 'quote': f'{QUOTE} variant {n}'} for n in range(1, 6)]}
    )
    assert len(parse_reply(many)) == 3
    dupes = json.dumps({'passages': [{'page': 1, 'quote': QUOTE}, {'page': 2, 'quote': QUOTE}]})
    assert len(parse_reply(dupes)) == 1


def test_clean_pages_validates_caps_and_sorts() -> None:
    rows = clean_pages([
        {'n': 9, 'text': 'nine'},
        {'n': 2, 'text': 'two'},
        {'n': 2, 'text': 'dupe'},
        {'n': 'x', 'text': 'bad'},
        {'n': 3, 'text': '   '},
        'junk',
    ])
    assert [r['n'] for r in rows] == [2, 9]
    long = clean_pages([{'n': 1, 'text': 'a' * 10_000}])
    assert len(long[0]['text']) == 4000
    with pytest.raises(ValueError):
        clean_pages([])
    with pytest.raises(ValueError):
        clean_pages('nope')


def test_locate_round_trip_with_fake_model() -> None:
    seen = {}

    def fake_ask(prompt: str) -> str:
        seen['prompt'] = prompt
        return '{"passages": [{"page": 2, "quote": "%s"}]}' % QUOTE

    out = locate('the citing passage', [{'n': 2, 'text': 'page two text'}], 'Citing Paper', ask=fake_ask)
    assert out == {'passages': [{'page': 2, 'quote': QUOTE}]}
    assert 'the citing passage' in seen['prompt']
    assert '[page 2]' in seen['prompt']
    assert 'Citing Paper' in seen['prompt']
    miss = locate('q', [{'n': 1, 'text': 't'}], ask=lambda _: '{"passages": []}')
    assert miss == {'passages': []}
    with pytest.raises(ValueError):
        locate('', [{'n': 1, 'text': 't'}], ask=fake_ask)


def test_resolve_cite_keeps_only_known_ids_in_order() -> None:
    papers = [
        {'paper_id': 'a', 'title': 'Paper A'},
        {'paper_id': 'b', 'title': 'Paper B'},
    ]
    reply = '{"paper_ids": ["b", "ghost", "a", "b"]}'
    out = resolve_cite('cites things', 'refs text', papers, ask=lambda _: reply)
    assert out == {'paper_ids': ['b', 'a']}
    assert parse_resolve_reply('junk', {'a'}) == []
    with pytest.raises(ValueError):
        resolve_cite('q', '', [], ask=lambda _: reply)


def test_prompts_demand_verbatim_json_and_substantive_sections() -> None:
    p = build_prompt('q', [{'n': 1, 'text': 'text'}])
    assert 'character-for-character' in p
    assert 'ONLY a JSON object' in p
    assert '"passages"' in p
    assert '1 to 3 passages' in p
    assert 'abstract, introduction, and related-work' in p
    assert 'Never pick a sentence whose job is to cite other works' in p
    assert 'untrusted data' in p
    r = build_resolve_prompt('q', 'refs', [{'paper_id': 'a', 'title': 'T'}])
    assert '"paper_ids"' in r
    assert '- a: T' in r


def test_identical_prompts_share_one_model_call(monkeypatch: pytest.MonkeyPatch) -> None:
    import lib.locate as locate_mod

    calls: list[str] = []

    def fake_auto(prompt: str, agent=None) -> str:
        calls.append(prompt)
        return '{"passages": [{"page": 1, "quote": "%s"}]}' % QUOTE

    monkeypatch.setattr(locate_mod, '_ask_auto', fake_auto)
    locate_mod._DONE.clear()
    pages = [{'n': 1, 'text': 'page text'}]
    first = locate_mod.locate('same question', pages)
    second = locate_mod.locate('same question', pages)
    assert first == second == {'passages': [{'page': 1, 'quote': QUOTE}]}
    assert len(calls) == 1
    locate_mod.locate('a different question', pages)
    assert len(calls) == 2
    # explicit ask (tests, callers with their own model) bypasses the cache
    out = locate_mod.locate('same question', pages, ask=lambda _: '{"passages": []}')
    assert out == {'passages': []}
    locate_mod._DONE.clear()


def _post(port: int, path: str, payload: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        f'http://127.0.0.1:{port}{path}',
        data=json.dumps(payload).encode('utf-8'),
        method='POST',
        headers={'Content-Type': 'application/json'},
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read())
    except urllib.error.HTTPError as err:
        return err.code, json.loads(err.read())


def test_locate_endpoints(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    run = _write_run(tmp_path)
    monkeypatch.setattr(
        serve_literature,
        'locate',
        lambda q, pages, from_title='', agent=None: {'passages': [{'page': 2, 'quote': QUOTE}]},
    )
    httpd, port = bind_server(make_handler(run), 18400)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        code, body = _post(port, '/api/locate', {'q': 'x', 'pages': [{'n': 1, 'text': 't'}]})
        assert (code, body) == (200, {'passages': [{'page': 2, 'quote': QUOTE}]})

        code, body = _post(port, '/api/resolve-cite', {'q': '', 'papers': []})
        assert code == 400

        def unavailable(*args, **kwargs):
            raise LocateUnavailable('set ANTHROPIC_API_KEY or install the claude CLI')

        monkeypatch.setattr(serve_literature, 'resolve_cite', unavailable)
        code, body = _post(
            port,
            '/api/resolve-cite',
            {'q': 'x', 'papers': [{'paper_id': 'a', 'title': 'T'}]},
        )
        assert code == 503
        assert 'ANTHROPIC_API_KEY' in body['error']
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_cli_fallback_runs_the_tool_free_worker_command(monkeypatch):
    import lib.locate as locate_mod
    seen = {}

    def fake_ask_text(agent, prompt, work_dir):
        seen['agent'] = agent
        return 'reply'
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    monkeypatch.setattr(locate_mod.shutil, 'which', lambda name: name)
    monkeypatch.setattr(locate_mod, 'ask_text', fake_ask_text)
    assert locate_mod._ask_auto('prompt') == 'reply'
    assert seen['agent'].host == 'claude' and seen['agent'].model == locate_mod._model()


def test_portals_ask_the_host_and_model_the_viewer_was_started_with(monkeypatch):
    import lib.locate as locate_mod
    from lib.agent_runtime import AgentConfig
    seen = {}

    def fake_ask_text(agent, prompt, work_dir):
        seen['agent'] = agent
        return 'reply'
    monkeypatch.delenv('ANTHROPIC_API_KEY', raising=False)
    monkeypatch.setattr(AgentConfig, 'problem', lambda self: '')
    monkeypatch.setattr(locate_mod, 'ask_text', fake_ask_text)
    codex = AgentConfig('codex', 'gpt-6-astra', 'high')
    assert locate_mod._ask_auto('prompt', codex) == 'reply'
    assert seen['agent'] == codex


def test_the_server_hands_portals_its_launch_host(tmp_path, monkeypatch):
    from lib.agent_runtime import AgentConfig
    codex = AgentConfig('codex', 'gpt-6-astra', 'high')
    seen = []
    monkeypatch.setattr(serve_literature, 'locate', lambda *a, agent=None: seen.append(agent) or {'passages': []})
    monkeypatch.setattr(serve_literature, 'resolve_cite', lambda *a, agent=None: seen.append(agent) or {'paper_ids': []})
    httpd, port = bind_server(make_handler(_write_run(tmp_path), agent=codex), 18400)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        _post(port, '/api/locate', {'q': 'x', 'pages': [{'n': 1, 'text': 't'}]})
        _post(port, '/api/resolve-cite', {'q': 'x', 'papers': [{'paper_id': 'a', 'title': 'T'}]})
    finally:
        httpd.shutdown()
        httpd.server_close()
    assert seen == [codex, codex]
