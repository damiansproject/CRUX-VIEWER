"""Standalone mode: --sources scaffolds a run dir from a plain folder of PDFs."""

from __future__ import annotations

import json
import sys
import threading
import urllib.request
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / '.claude' / 'skills' / 'crux-viewer' / 'scripts'
sys.path.insert(0, str(SCRIPTS))

import serve_literature  # noqa: E402
from lib.catalog import load_catalog  # noqa: E402
from lib.sources import scaffold_folder  # noqa: E402

from test_literature_catalog import _write_run  # noqa: E402


class _FakeServer:
    """Stands in for ThreadingHTTPServer so main() returns instead of serving."""

    def __init__(self) -> None:
        self.closed = False

    def serve_forever(self) -> None:
        pass

    def server_close(self) -> None:
        self.closed = True


def _main(monkeypatch, capsys, *argv: str) -> tuple[int, str, str]:
    server = _FakeServer()
    monkeypatch.setattr(serve_literature, 'bind_server', lambda handler, port: (server, port))
    monkeypatch.setattr(serve_literature.webbrowser, 'open', lambda url: pytest.fail('opened ' + url))
    code = serve_literature.main([*argv, '--no-open'])
    out = capsys.readouterr()
    return code, out.out, out.err


def _folder(tmp_path: Path, *names: str) -> Path:
    folder = tmp_path / 'papers'
    folder.mkdir(exist_ok=True)
    for name in names or ('Alpha Study.pdf', 'beta.pdf'):
        (folder / name).write_bytes(b'%PDF-1.4 ' + name.encode('utf-8'))
    return folder


def _rows(run: Path) -> list[dict]:
    raw = json.loads((run / 'literature_sources.json').read_text(encoding='utf-8'))
    return raw['papers']


def test_sources_scaffolds_run_dir(tmp_path: Path, monkeypatch, capsys) -> None:
    folder = _folder(tmp_path)
    code, out, err = _main(monkeypatch, capsys, '--sources', str(folder))
    assert code == 0
    assert err == ''
    run = folder / '.crux-viewer'
    assert (run / 'claims.jsonl').read_bytes() == b''
    rows = _rows(run)
    assert [r['title'] for r in rows] == ['Alpha Study', 'beta']
    assert all(r['origin'] == 'pdf' for r in rows)
    assert all(Path(r['source_pdf']).is_absolute() for r in rows)
    assert all(Path(r['source_pdf']).parent == folder.resolve() for r in rows)
    assert len({r['paper_id'] for r in rows}) == 2
    assert '2 sources' in out


def test_sources_catalog_serves_papers(tmp_path: Path) -> None:
    run = scaffold_folder(_folder(tmp_path))
    papers = load_catalog(run)['papers']
    assert len(papers) == 2
    for row in papers:
        assert row['claim_count'] == 0
        assert row['quote_count'] == 0
        assert row['pdf_ok'] is True
        assert row['origin'] == 'pdf'


def test_sources_served_over_http(tmp_path: Path) -> None:
    run = scaffold_folder(_folder(tmp_path))
    httpd, port = serve_literature.bind_server(serve_literature.make_handler(run), 18100)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    try:
        catalog = json.loads(
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/catalog', timeout=5).read()
        )
        pid = catalog['papers'][0]['paper_id']
        paper = json.loads(
            urllib.request.urlopen(f'http://127.0.0.1:{port}/api/paper/{pid}', timeout=5).read()
        )
        assert paper['claims'] == []
        pdf = urllib.request.urlopen(f'http://127.0.0.1:{port}/pdf/{pid}', timeout=5).read()
        assert pdf.startswith(b'%PDF')
    finally:
        httpd.shutdown()
        httpd.server_close()


def test_sources_is_idempotent(tmp_path: Path) -> None:
    folder = _folder(tmp_path)
    run = scaffold_folder(folder)
    before = (run / 'literature_sources.json').read_bytes()
    assert scaffold_folder(folder) == run
    assert (run / 'literature_sources.json').read_bytes() == before


def test_sources_given_as_a_relative_path_is_idempotent(tmp_path: Path, monkeypatch) -> None:
    folder = _folder(tmp_path)
    monkeypatch.chdir(tmp_path)  # `--sources path/to/pdfs`, as the README shows
    run = scaffold_folder(folder.name)
    before = (run / 'literature_sources.json').read_bytes()
    scaffold_folder(folder.name)
    assert (run / 'literature_sources.json').read_bytes() == before


def test_sources_keeps_user_edits(tmp_path: Path) -> None:
    folder = _folder(tmp_path)
    run = scaffold_folder(folder)
    rows = _rows(run)
    rows[0]['title'] = 'Renamed By Hand'
    rows[0]['paper_id'] = 'my_own_id'
    (run / 'literature_sources.json').write_text(
        json.dumps({'v': 1, 'papers': rows}), encoding='utf-8'
    )
    (folder / 'gamma.pdf').write_bytes(b'%PDF-1.4 gamma')
    scaffold_folder(folder)
    after = _rows(run)
    assert len(after) == 3
    assert after[0]['paper_id'] == 'my_own_id'
    assert after[0]['title'] == 'Renamed By Hand'
    assert [r['title'] for r in after] == ['Renamed By Hand', 'beta', 'gamma']


def test_sources_keeps_vanished_and_picker_rows(tmp_path: Path) -> None:
    from lib.sources import add_pdf

    folder = _folder(tmp_path)
    run = scaffold_folder(folder)
    picked = add_pdf(run, 'Uploaded.pdf', b'%PDF-1.4 up')
    (folder / 'beta.pdf').unlink()
    scaffold_folder(folder)
    ids = [r['paper_id'] for r in _rows(run)]
    assert picked['paper_id'] in ids
    assert len(ids) == 3
    gone = next(p for p in load_catalog(run)['papers'] if p['title'] == 'beta')
    assert gone['pdf_ok'] is False


def test_sources_is_not_recursive_and_matches_upper_case(tmp_path: Path) -> None:
    folder = _folder(tmp_path, 'top.PDF', 'notes.txt')
    nested = folder / 'sub'
    nested.mkdir()
    (nested / 'deep.pdf').write_bytes(b'%PDF-1.4 deep')
    rows = _rows(scaffold_folder(folder))
    assert [r['title'] for r in rows] == ['top']


def test_sources_ids_stay_unique_on_slug_collision(tmp_path: Path) -> None:
    rows = _rows(scaffold_folder(_folder(tmp_path, 'A B.pdf', 'A_B.pdf')))
    ids = [r['paper_id'] for r in rows]
    assert ids == ['A_B', 'A_B_2']


def test_sources_explicit_run_dir(tmp_path: Path, monkeypatch, capsys) -> None:
    folder = _folder(tmp_path)
    state = tmp_path / 'state'
    code, _, err = _main(monkeypatch, capsys, '--sources', str(folder), '--run', str(state))
    assert code == 0 and err == ''
    assert len(_rows(state)) == 2
    assert not (folder / '.crux-viewer').exists()


def test_sources_zero_pdfs_is_a_clean_error(tmp_path: Path, monkeypatch, capsys) -> None:
    empty = tmp_path / 'nothing'
    empty.mkdir()
    (empty / 'readme.txt').write_text('hi', encoding='utf-8')
    code, _, err = _main(monkeypatch, capsys, '--sources', str(empty))
    assert code == 1
    assert err.splitlines() == [f'error: no PDFs in {empty.resolve()}']
    assert not (empty / '.crux-viewer').exists()


def test_sources_missing_folder_is_a_clean_error(tmp_path: Path, monkeypatch, capsys) -> None:
    missing = tmp_path / 'absent'
    code, _, err = _main(monkeypatch, capsys, '--sources', str(missing))
    assert code == 1
    assert err.splitlines() == [f'error: sources folder not found: {missing}']


def test_malformed_claims_is_a_clean_error(tmp_path: Path, monkeypatch, capsys) -> None:
    run = _write_run(tmp_path)
    (run / 'claims.jsonl').write_text(
        '{"paper_id": "p_one"}\n{"paper_id": broken}\n', encoding='utf-8'
    )
    code, _, err = _main(monkeypatch, capsys, '--run', str(run))
    assert code == 1
    lines = err.splitlines()
    assert len(lines) == 1
    assert lines[0].startswith(f'error: {run / "claims.jsonl"}:2: bad JSON (')


def test_malformed_claims_is_a_clean_error_in_sources_mode(
    tmp_path: Path, monkeypatch, capsys
) -> None:
    folder = _folder(tmp_path)
    run = folder / '.crux-viewer'
    run.mkdir()
    (run / 'claims.jsonl').write_text('not json\n', encoding='utf-8')
    code, _, err = _main(monkeypatch, capsys, '--sources', str(folder))
    assert code == 1
    lines = err.splitlines()
    assert len(lines) == 1
    assert lines[0].startswith(f'error: {run / "claims.jsonl"}:1: bad JSON (')
    assert (run / 'claims.jsonl').read_text(encoding='utf-8') == 'not json\n'


def test_malformed_claims_still_400s_per_request(tmp_path: Path) -> None:
    run = _write_run(tmp_path)
    (run / 'claims.jsonl').write_text('{oops}\n', encoding='utf-8')
    with pytest.raises(ValueError, match='bad JSON'):
        load_catalog(run)


def test_run_flow_is_unaffected(tmp_path: Path, monkeypatch, capsys) -> None:
    run = _write_run(tmp_path)
    code, out, err = _main(monkeypatch, capsys, '--run', str(run), '--paper', 'p_one')
    assert code == 0 and err == ''
    assert '1 source ' in out
    assert '/view/p_one' in out
    assert not (run / 'literature_sources.json').exists()


def test_neither_flag_is_an_argparse_error(capsys) -> None:
    with pytest.raises(SystemExit) as exc:
        serve_literature.main(['--no-open'])
    assert exc.value.code == 2
    assert 'one of --run or --sources' in capsys.readouterr().err
