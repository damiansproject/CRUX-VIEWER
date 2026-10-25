from __future__ import annotations

"""Serve a local literature viewer for one CRUX run, or a folder of PDFs.

With ``--sources`` the run dir is scaffolded from the folder and defaults to
``<folder>/.crux-viewer/``; everything below is unchanged from there on.

Binds 127.0.0.1 only. Writes ``<run>/literature_marks/``,
``<run>/literature_meta/``, ``<run>/literature_chat/``, and
``<run>/literature_sources.json`` plus PDFs under ``literature_inbox/``.
"""

import argparse
import html
import io
import json
import mimetypes
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

try:
    from pypdf import PdfReader, PdfWriter
except ModuleNotFoundError:
    install_command = f'"{sys.executable}" -m pip install pypdf==6.14.2'
    if sys.platform == 'win32':
        install_command = '& ' + install_command
    raise SystemExit(f'PDF previews require pypdf. Install it for this interpreter:\n{install_command}')

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.catalog import load_catalog, load_claim, load_paper
from lib.chat import append_message, load_chat, read_chat_file, responding_to, watching
from lib.context import _cleaned_pages, claim_context
from lib.grab import grab
from lib.locate import LocateUnavailable, locate, resolve_cite
from lib.marks import load_marks, save_marks
from lib.paper_info import apply_resolved, load_info, load_overlay, resolve_identifier, save_overlay
from lib.slash_commands import find_project_root, list_commands
from lib.extraction import ExtractionBusy, ExtractionJobs
from lib.agent_runtime import AgentConfig, resolve_agent
from lib.chat_worker import ChatWatcher
from lib.sources import MAX_PDF, STANDALONE_RUN_DIR, add_pdf, add_url, scaffold_folder

VIEWER_ROOT = Path(__file__).resolve().parent / 'viewer'
PAPER_ID_RE = re.compile(r'^[A-Za-z0-9_.:-]+$')
UA = (
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36'
)
CSP_META = re.compile(
    r'<meta[^>]+http-equiv=["\']Content-Security-Policy["\'][^>]*>',
    re.I,
)
HEAD_OPEN = re.compile(r'<head[^>]*>', re.I)


def _send(
    handler: BaseHTTPRequestHandler,
    code: int,
    body: bytes,
    content_type: str,
    extra: dict[str, str] | None = None,
) -> None:
    headers = {
        'Content-Type': content_type,
        'Content-Length': str(len(body)),
        'Cache-Control': 'no-store',
    }
    headers.update(extra or {})
    handler.send_response(code)
    for key, value in headers.items():
        handler.send_header(key, value)
    handler.end_headers()
    handler.wfile.write(body)


def _json(handler: BaseHTTPRequestHandler, code: int, payload: object) -> None:
    body = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    _send(handler, code, body, 'application/json; charset=utf-8')


def _read_viewer(rel: str) -> bytes:
    path = (VIEWER_ROOT / rel).resolve()
    path.relative_to(VIEWER_ROOT.resolve())
    if not path.is_file():
        raise FileNotFoundError(rel)
    return path.read_bytes()


def _inject_base(raw: bytes, url: str) -> bytes:
    try:
        text = raw.decode('utf-8')
        enc = 'utf-8'
    except UnicodeDecodeError:
        text = raw.decode('latin-1')
        enc = 'latin-1'
    base = f'<base href="{html.escape(url, quote=True)}">'
    style = (
        '<link rel="stylesheet" href="/static/kind-marks.css">'
        '<style>mark.crux-quote{color:inherit;padding:.05em 0;cursor:pointer}</style>'
    )
    text = CSP_META.sub('', text)
    if HEAD_OPEN.search(text):
        text = HEAD_OPEN.sub(lambda m: m.group(0) + base + style, text, count=1)
    else:
        text = base + style + text
    return text.encode(enc)


class _WebRedirects(urllib.request.HTTPRedirectHandler):
    """Follow redirects only to http(s), and never read the redirect's own body."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        fp.close()
        if urllib.parse.urlparse(newurl).scheme not in {'http', 'https'}:
            raise urllib.error.HTTPError(newurl, code, 'redirect leaves the web', headers, None)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def _fetch_live(url: str) -> tuple[bytes, str, str]:
    if urllib.parse.urlparse(url).scheme not in {'http', 'https'}:
        raise ValueError('source_url must be an http(s) address')
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': 'text/html,*/*'})
    with urllib.request.build_opener(_WebRedirects).open(req, timeout=30) as resp:
        if resp.status != 200:  # e.g. PubMed answers scripts with a 203 bot check
            raise urllib.error.HTTPError(url, resp.status, 'not the page', resp.headers, None)
        data = resp.read(MAX_PDF)
        ctype = resp.headers.get_content_type() or 'application/octet-stream'
        final = resp.geturl() or url
    return data, ctype, final


class LiteratureHandler(BaseHTTPRequestHandler):
    run_dir: Path
    chat_channel = None
    agent: AgentConfig | None = None

    def log_message(self, fmt: str, *args: object) -> None:
        sys.stderr.write('%s - %s\n' % (self.address_string(), fmt % args))

    def _foreign(self) -> bool:
        """Refuse other sites and DNS-rebound hosts; only this Viewer's own pages may call it."""
        hosts = {f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}'}
        origin = self.headers.get('Origin')
        if self.headers.get('Host') in hosts and origin in {None, *(f'http://{host}' for host in hosts)}:
            return False
        _json(self, 403, {'error': 'Use this Viewer window.'})
        return True

    def do_GET(self) -> None:  # noqa: N802
        if self._foreign():
            return
        parsed = urllib.parse.urlparse(self.path)
        try:
            self._route(parsed.path, parsed.query)
        except FileNotFoundError:
            _send(self, 404, b'not found', 'text/plain; charset=utf-8')
        except KeyError:
            _json(self, 404, {'error': 'unknown paper'})
        except ValueError as exc:
            _json(self, 400, {'error': str(exc)})
        except urllib.error.URLError as exc:
            _json(self, 502, {'error': f'live fetch failed: {exc.reason}'})

    def do_PUT(self) -> None:  # noqa: N802
        if self._foreign():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith('/api/marks/'):
                paper_id = _paper_id(path[len('/api/marks/') :])
                load_paper(self.run_dir, paper_id)
                payload = _read_json_body(self)
                marks = save_marks(self.run_dir, paper_id, payload)
                _json(self, 200, {'v': 1, 'marks': marks})
                return
            if path.startswith('/api/info/'):
                paper_id = _paper_id(path[len('/api/info/') :])
                load_paper(self.run_dir, paper_id)
                payload = _read_json_body(self)
                if not isinstance(payload, dict):
                    raise ValueError('expected object')
                merged = {**load_overlay(self.run_dir, paper_id), **payload}
                save_overlay(self.run_dir, paper_id, merged)
                _json(self, 200, load_info(self.run_dir, paper_id))
                return
            raise FileNotFoundError(path)
        except FileNotFoundError:
            _send(self, 404, b'not found', 'text/plain; charset=utf-8')
        except KeyError:
            _json(self, 404, {'error': 'unknown paper'})
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            _json(self, 400, {'error': str(exc)})

    def do_POST(self) -> None:  # noqa: N802
        if self._foreign():
            return
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith('/api/extraction/'):
                if self.headers.get_content_type() != 'application/json':
                    raise ValueError('Send extraction as JSON.')
                _read_json_body(self)
                paper_id = _paper_id(path[len('/api/extraction/'):])
                try:
                    _json(self, 202, self.extraction_jobs.start(paper_id))
                except ExtractionBusy as exc:
                    _json(self, 409, {'error': str(exc)})
                return
            if path == '/api/sources':
                row = _add_source(self)
                self.extraction_jobs.enqueue_missing(row['paper_id'])
                _json(self, 201, row)
                return
            if path.startswith('/api/chat/'):
                _json(self, 201, _post_chat(self, path))
                return
            if path.startswith('/api/info/') and path.rstrip('/').endswith('/resolve'):
                _json(self, 200, _resolve_info(self, path))
                return
            if path == '/api/locate' or path == '/api/resolve-cite':
                try:
                    _json(self, 200, _model_assist(self, path))
                except LocateUnavailable as exc:
                    _json(self, 503, {'error': str(exc)})
                except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                    raise
                except Exception as exc:
                    sys.stderr.write('POST %s failed: %s\n' % (path, exc))
                    _json(self, 502, {'error': str(exc) or 'model call failed'})
                return
            if path == '/api/grab':
                payload = _read_json_body(self)
                if not isinstance(payload, dict):
                    raise ValueError('expected object')
                try:
                    row = grab(self.run_dir, payload.get('entry'))
                    self.extraction_jobs.enqueue_missing(row['paper_id'])
                    _json(self, 201, row)
                except LookupError:
                    _json(self, 404, {'error': 'No open copy found.'})
                except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
                    raise
                except Exception as exc:
                    sys.stderr.write('POST /api/grab failed: %s\n' % exc)
                    _json(self, 502, {'error': str(exc) or 'fetch failed'})
                return
            raise FileNotFoundError(path)
        except FileNotFoundError:
            _send(self, 404, b'not found', 'text/plain; charset=utf-8')
        except KeyError:
            _json(self, 404, {'error': 'unknown paper'})
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError) as exc:
            _json(self, 400, {'error': str(exc)})
        except OSError as exc:
            _json(self, 500, {'error': f'could not save source: {exc}'})
        except Exception as exc:
            sys.stderr.write('POST %s failed: %s\n' % (path, exc))
            _json(self, 500, {'error': str(exc) or 'upload failed'})

    def _route(self, path: str, query: str = '') -> None:
        if path == '/' or path == '/index.html':
            _send(self, 200, _read_viewer('picker.html'), 'text/html; charset=utf-8')
            return
        if path == '/workspace' or path.startswith('/view/'):
            _send(self, 200, _read_viewer('view.html'), 'text/html; charset=utf-8')
            return
        if path.startswith('/reader/'):
            _send(self, 200, _read_viewer('reader.html'), 'text/html; charset=utf-8')
            return
        if path.startswith('/static/'):
            rel = path[len('/static/') :]
            data = _read_viewer(rel)
            ctype = mimetypes.guess_type(rel)[0] or 'application/octet-stream'
            if rel.endswith('.js') or rel.endswith('.mjs'):
                ctype = 'text/javascript; charset=utf-8'
            elif rel.endswith('.css'):
                ctype = 'text/css; charset=utf-8'
            _send(self, 200, data, ctype)
            return
        if path == '/api/catalog':
            _json(self, 200, load_catalog(self.run_dir))
            return
        if path.startswith('/api/extraction/'):
            paper_id = _paper_id(path[len('/api/extraction/'):])
            _json(self, 200, self.extraction_jobs.status(paper_id))
            return
        if path == '/api/commands':
            _json(self, 200, _commands_payload(self))
            return
        if path.startswith('/api/paper/'):
            paper_id = _paper_id(path[len('/api/paper/') :])
            _json(self, 200, load_paper(self.run_dir, paper_id))
            return
        if path.startswith('/api/claim/'):
            claim_id = _paper_id(path[len('/api/claim/') :])
            claim = load_claim(self.run_dir, claim_id)
            payload = claim_context(self.run_dir, claim)
            payload['source_in_catalog'] = any(
                p['paper_id'] == claim.get('paper_id')
                for p in load_catalog(self.run_dir)['papers']
            )
            _json(self, 200, payload)
            return
        if path.startswith('/api/marks/'):
            paper_id = _paper_id(path[len('/api/marks/') :])
            load_paper(self.run_dir, paper_id)
            _json(self, 200, load_marks(self.run_dir, paper_id))
            return
        if path.startswith('/api/info/'):
            paper_id = _paper_id(path[len('/api/info/') :])
            load_paper(self.run_dir, paper_id)
            _json(self, 200, load_info(self.run_dir, paper_id))
            return
        if path.startswith('/api/chat/'):
            paper_id, filename = _chat_route(path)
            if paper_id != '_workspace':
                load_paper(self.run_dir, paper_id)
            if filename:
                data, ctype = read_chat_file(self.run_dir, paper_id, filename)
                _send(self, 200, data, ctype)
                return
            chat = load_chat(self.run_dir, paper_id)
            chat['watching'] = watching(self.run_dir)
            chat['responding_to'] = responding_to(self.run_dir, paper_id)
            if self.chat_channel is not None:
                chat.update(self.chat_channel.status(paper_id))
            _json(self, 200, chat)
            return
        if path.startswith('/pdf/'):
            paper_id = _paper_id(path[len('/pdf/') :])
            paper = load_paper(self.run_dir, paper_id)
            pdf = paper.get('source_pdf')
            if not pdf or not Path(pdf).is_file():
                raise FileNotFoundError('pdf')
            options = urllib.parse.parse_qs(query, keep_blank_values=True)
            if 'text' in options:
                with open(pdf, 'rb') as source:
                    pages = [page.extract_text() or '' for page in PdfReader(source).pages]
                _send(self, 200, json.dumps(pages).encode('utf-8'), 'application/json',
                      {'Cache-Control': 'private, max-age=600'})
                return
            data = _pdf_page(pdf, int(options['page'][0])) if 'page' in options else Path(pdf).read_bytes()
            # cacheable so a warmed preview reloads the file from browser cache
            extra = {'Cache-Control': 'private, max-age=600'}
            if _wants_download(query):
                extra['Content-Disposition'] = _pdf_disposition(paper_id, pdf)
            _send(self, 200, data, 'application/pdf', extra)
            return
        if path.startswith('/proxy/'):
            paper_id = _paper_id(path[len('/proxy/') :])
            paper = load_paper(self.run_dir, paper_id)
            url = paper.get('source_url')
            if not url:
                raise ValueError('no source_url for this paper')
            try:
                data, ctype, final = _fetch_live(url)
            except (urllib.error.URLError, TimeoutError):
                pages = _cleaned_pages(self.run_dir, paper_id)
                if not pages:
                    raise
                link = html.escape(url, quote=True)
                data = (f'<p>The live page did not load; this is the stored text. <a href="{link}">Original page</a></p>'
                        + ''.join(f'<p style="white-space:pre-wrap">{html.escape(p.get("text") or "")}</p>' for p in pages)).encode('utf-8')
                ctype, final = 'text/html', url
            if 'html' in ctype:
                data = _inject_base(data, final)
                ctype = 'text/html; charset=utf-8'
            # Keep source text accessible for highlighting without executing it as Viewer.
            _send(self, 200, data, ctype, {'Content-Security-Policy':
                  'sandbox allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-downloads'})
            return
        raise FileNotFoundError(path)


def _pdf_page(path: str, number: int) -> bytes:
    """Send one original page for a preview; keep full documents out of hover loads."""
    with open(path, 'rb') as source:
        reader = PdfReader(source)
        if not 1 <= number <= len(reader.pages):
            raise ValueError('page is outside this document')
        writer = PdfWriter()
        # Exclude cross-page article/link graphs from the preview's page clone.
        writer.add_page(reader.pages[number - 1], excluded_keys=['/Annots', '/B'])
        output = io.BytesIO()
        writer.write(output)
        return output.getvalue()


def _paper_id(raw: str) -> str:
    paper_id = urllib.parse.unquote(raw).strip().strip('/')
    if not PAPER_ID_RE.match(paper_id):
        raise ValueError('invalid paper id')
    return paper_id


def _chat_route(path: str) -> tuple[str, str | None]:
    rest = urllib.parse.unquote(path[len('/api/chat/') :]).strip().strip('/')
    if '/file/' in rest:
        paper, name = rest.split('/file/', 1)
        return _paper_id(paper), name
    return _paper_id(rest), None


def _commands_payload(handler: BaseHTTPRequestHandler) -> dict:
    cls = type(handler)
    cached = getattr(cls, 'commands_cache', None)
    if cached is None:
        root = getattr(cls, 'project_root', None) or find_project_root(handler.run_dir)  # type: ignore[attr-defined]
        cached = list_commands(root)
        cls.commands_cache = cached  # type: ignore[attr-defined]
    return cached


def _wants_download(query: str) -> bool:
    qs = urllib.parse.parse_qs(query)
    flag = (qs.get('download') or ['0'])[0].strip().lower()
    return flag in {'1', 'true', 'yes'}


def _pdf_disposition(paper_id: str, pdf: str) -> str:
    name = Path(pdf).name or f'{paper_id}.pdf'
    name = re.sub(r'[\r\n"]', '', name) or f'{paper_id}.pdf'
    return f'attachment; filename="{name}"'


def _post_chat(handler: BaseHTTPRequestHandler, path: str) -> dict:
    paper_id, filename = _chat_route(path)
    if filename:
        raise FileNotFoundError(path)
    if paper_id != '_workspace':
        load_paper(handler.run_dir, paper_id)  # type: ignore[attr-defined]
    payload = _read_json_body(handler, 8_000_000)
    if not isinstance(payload, dict):
        raise ValueError('expected object')
    text = payload.get('text')
    if text is None:
        text = ''
    if not isinstance(text, str):
        raise ValueError('text required')
    role = payload.get('role') or 'user'
    if not isinstance(role, str):
        raise ValueError('role')
    reply_to = payload.get('in_reply_to')
    if reply_to is not None and not isinstance(reply_to, str):
        raise ValueError('in_reply_to')
    message = append_message(
        handler.run_dir,  # type: ignore[attr-defined]
        paper_id,
        role=role,
        text=text,
        in_reply_to=reply_to,
        attachments=payload.get('attachments'),
        context=payload.get('context'),
    )
    if role == 'user' and handler.chat_channel is not None:
        handler.chat_channel.notify(paper_id, message)
    return message


def _model_assist(handler: BaseHTTPRequestHandler, path: str) -> dict:
    payload = _read_json_body(handler, 8_000_000)
    if not isinstance(payload, dict):
        raise ValueError('expected object')
    q = payload.get('q')
    from_title = payload.get('from') or ''
    if path == '/api/locate':
        return locate(q, payload.get('pages'), from_title, agent=handler.agent)
    return resolve_cite(q, payload.get('refs'), payload.get('papers'), from_title, agent=handler.agent)


def _resolve_info(handler: BaseHTTPRequestHandler, path: str) -> dict:
    raw = path[len('/api/info/') :]
    if raw.rstrip('/').endswith('/resolve'):
        raw = raw[: raw.rstrip('/').rfind('/resolve')]
    paper_id = _paper_id(raw)
    load_paper(handler.run_dir, paper_id)  # type: ignore[attr-defined]
    payload = _read_json_body(handler)
    kind = ''
    if isinstance(payload, dict):
        kind = str(payload.get('from') or '').strip().lower()
    if kind not in {'doi', 'arxiv', 'pmid'}:
        raise ValueError('from must be doi, arxiv, or pmid')
    info = load_info(handler.run_dir, paper_id)  # type: ignore[attr-defined]
    value = info.get(kind)
    if not value:
        raise ValueError(f'no {kind} on this paper')
    fields = resolve_identifier(kind, str(value))
    return apply_resolved(handler.run_dir, paper_id, fields)  # type: ignore[attr-defined]


def _read_json_body(handler: BaseHTTPRequestHandler, limit: int = 2_000_000) -> object:
    length = int(handler.headers.get('Content-Length') or 0)
    if length < 0 or length > limit:
        raise ValueError('payload too large')
    raw = handler.rfile.read(length) if length else b''
    if not raw:
        return {'v': 1, 'marks': []}
    return json.loads(raw.decode('utf-8'))


def _add_source(handler: BaseHTTPRequestHandler) -> dict:
    ctype = handler.headers.get('Content-Type') or ''
    kind = ctype.split(';')[0].strip().lower()
    run_dir = handler.run_dir  # type: ignore[attr-defined]
    query = urllib.parse.parse_qs(urllib.parse.urlparse(handler.path).query)
    fallback_name = (query.get('name') or ['source.pdf'])[0]
    if kind == 'application/json':
        payload = _read_json_body(handler)
        if not isinstance(payload, dict):
            raise ValueError('expected object')
        url = payload.get('url')
        if not isinstance(url, str):
            raise ValueError('url required')
        return add_url(run_dir, url)
    length = int(handler.headers.get('Content-Length') or 0)
    if length <= 0:
        raise ValueError('empty upload')
    if length > MAX_PDF + 65_536:
        raise ValueError('pdf too large')
    raw = handler.rfile.read(length)
    if kind.startswith('multipart/'):
        fields = _parse_multipart(ctype, raw)
        url_field = fields.get('url')
        if url_field and not fields.get('file'):
            url = url_field[1].decode('utf-8', errors='replace').strip()
            return add_url(run_dir, url)
        file_field = fields.get('file')
        if not file_field:
            raise ValueError('missing file')
        name, data = file_field
        return add_pdf(run_dir, name or fallback_name, data)
    name = handler.headers.get('X-Filename') or fallback_name
    return add_pdf(run_dir, name, raw)


def _parse_multipart(content_type: str, body: bytes) -> dict[str, tuple[str | None, bytes]]:
    match = re.search(r'boundary=([^;]+)', content_type, re.I)
    if not match:
        raise ValueError('multipart boundary missing')
    boundary = match.group(1).strip().strip('"').encode('utf-8')
    marker = b'--' + boundary
    out: dict[str, tuple[str | None, bytes]] = {}
    for raw_part in body.split(marker):
        part = raw_part
        if part.startswith(b'\r\n'):
            part = part[2:]
        elif part.startswith(b'\n'):
            part = part[1:]
        if not part or part == b'--' or part.startswith(b'--'):
            continue
        if part.endswith(b'\r\n'):
            part = part[:-2]
        head, sep, payload = part.partition(b'\r\n\r\n')
        if not sep:
            continue
        headers = head.decode('utf-8', errors='replace')
        name_m = re.search(r'name="([^"]+)"', headers, re.I)
        if not name_m:
            continue
        fn_m = re.search(r'filename="([^"]*)"', headers, re.I)
        filename = fn_m.group(1) if fn_m else None
        out[name_m.group(1)] = (filename, payload)
    return out


def make_handler(run_dir: Path, project_root: Path | None = None,
                 agent: AgentConfig | None = None) -> type[LiteratureHandler]:
    """Bind a run and launch model; chat delivery is attached by the serving host."""
    class Bound(LiteratureHandler):
        pass

    Bound.run_dir = run_dir.resolve()
    Bound.project_root = (Path(project_root) if project_root else find_project_root(run_dir)).resolve()
    Bound.commands_cache = None
    Bound.agent = agent
    Bound.extraction_jobs = ExtractionJobs(Bound.run_dir, agent)
    return Bound


def bind_server(handler: type[BaseHTTPRequestHandler], start_port: int) -> tuple[ThreadingHTTPServer, int]:
    for port in range(start_port, start_port + 20):
        try:
            httpd = ThreadingHTTPServer(('127.0.0.1', port), handler)
            return httpd, port
        except OSError:
            continue
    raise RuntimeError(f'no free port in {start_port}–{start_port + 19}')


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description='Open sources with claim highlights: a CRUX run (--run) '
        'or a plain folder of PDFs (--sources).'
    )
    parser.add_argument('--run', help='run directory containing claims.jsonl')
    parser.add_argument(
        '--sources',
        help='folder of PDFs to open, served in place; scans top-level *.pdf only, '
        f'not subfolders. State goes in <folder>/{STANDALONE_RUN_DIR}/ unless --run is also given',
    )
    parser.add_argument('--paper', help='open this paper_id directly')
    parser.add_argument('--port', type=int, default=8765)
    parser.add_argument('--no-open', action='store_true', help='do not launch a browser')
    parser.add_argument('--host', choices=['codex', 'cursor', 'claude'], help='launching session host')
    parser.add_argument('--model', help='model selected in the launching session; no provider fallback')
    parser.add_argument('--effort', help='launching model reasoning effort, where supported')
    args = parser.parse_args(argv)
    if not args.run and not args.sources:
        parser.error('one of --run or --sources is required')

    try:
        run_dir = scaffold_folder(args.sources, args.run) if args.sources else Path(args.run)
        catalog = load_catalog(run_dir)
    except (OSError, ValueError) as exc:
        print(f'error: {exc}', file=sys.stderr)
        return 1
    agent = resolve_agent(args.host, args.model, args.effort)
    handler = make_handler(run_dir, agent=agent)
    httpd, port = bind_server(handler, args.port)
    path = '/'
    if args.paper:
        load_paper(run_dir, args.paper)
        path = '/view/' + urllib.parse.quote(args.paper, safe='')
    url = f'http://127.0.0.1:{port}{path}'
    n = len(catalog['papers'])
    print(f'CRUX Viewer  {url}', flush=True)
    print(f'  {n} source{"s" if n != 1 else ""} from {run_dir.resolve()}', flush=True)
    watcher = ChatWatcher(run_dir, agent)
    handler.chat_channel = watcher
    watcher.start()
    print(f'  {agent.label} / {agent.model or "model not set"}: '
          f'{agent.problem() or "chat listener connected"}', flush=True)
    if not args.no_open:
        webbrowser.open(url)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\nstopped')
    finally:
        watcher.close()
        httpd.server_close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
