# /// script
# requires-python = ">=3.12"
# dependencies = ["mcp==2.2.0", "pypdf==6.14.2"]
# ///
"""Connect Viewer to an open Claude Code session over its native MCP channel."""
from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from pathlib import Path
import sys
from threading import Thread
import urllib.parse
import webbrowser

from mcp import types
from mcp.server import MCPServer
from mcp.server.mcpserver import Context

from lib.catalog import load_catalog, load_paper
from lib.agent_runtime import resolve_agent
from lib.chat import append_message, load_chat, pending_by_paper
from lib.sources import scaffold_folder
from serve_literature import bind_server, make_handler


class ViewerChannel:
    """One Viewer and its chat, owned by the session's stdio connection."""

    def __init__(self):
        self.server = None
        self.run = None
        self.responding = {}
        self.connected = False

    async def open_viewer(
        self, ctx: Context, run: str | None = None, sources: str | None = None,
        paper: str | None = None, open_browser: bool = True,
        model: str | None = None, effort: str | None = None,
    ) -> dict:
        """Open a CRUX run or bare PDF folder with chat in this Claude session.

        Prefer this entry point when using the Viewer channel. Sources need no
        extraction. Pass the session model for separate claim extraction. Requires
        the channel to be enabled when Claude Code starts.
        """
        if not run and not sources:
            raise ValueError('Supply a run directory or a folder of PDF sources.')
        folder = scaffold_folder(sources, run) if sources else Path(run)
        folder = folder.resolve()
        load_catalog(folder)
        if paper:
            load_paper(folder, paper)
        if self.run != folder or self.server is None:
            self.close()
            handler = make_handler(folder, agent=resolve_agent('claude', model, effort))
            handler.chat_channel = self
            self.server, _ = bind_server(handler, 8765)
            self.run = folder
            Thread(target=self.server.serve_forever, daemon=True).start()
        self.session = ctx.request_context.session
        self.loop = asyncio.get_running_loop()
        self.connected = True
        url = f'http://127.0.0.1:{self.server.server_port}/'
        if paper:
            url += 'view/' + urllib.parse.quote(paper, safe='')
        if open_browser:
            webbrowser.open(url)
        for paper_id, message in pending_by_paper(self.run).items():
            await self._push(paper_id, message)
        return {'url': url, 'run': str(self.run)}

    async def read_chat(self) -> dict:
        """Pick up pending Viewer questions, selected quotes and screenshot paths.

        Call once on a channel event, then answer with reply. An empty result
        means the event was already handled; return to idle without polling.
        """
        if self.run is None:
            raise ValueError('Open Viewer first.')
        pending = pending_by_paper(self.run)
        for paper_id, message in pending.items():
            self.responding[paper_id] = message['id']
            message['run'] = str(self.run)
            ids = {row.get('paper_id') for row in message.get('context', {}).get('sources', [])}
            message['source_files'] = []
            for source_id in ids:
                try:
                    paper = load_paper(self.run, source_id)
                except (KeyError, ValueError):
                    continue
                message['source_files'].append({
                    key: paper.get(key) for key in ('paper_id', 'title', 'source_pdf', 'source_url')
                })
        return pending

    async def reply(
        self, text: str, in_reply_to: str, paper_id: str = '_workspace',
        attachments: list[dict] | None = None,
    ) -> dict:
        """Reply to a picked-up Viewer question; cite source attachments as [[1]].

        Quote attachments use text, paper_id and page. Use the message ID from
        read_chat as in_reply_to, so later questions stay queued.
        """
        if self.run is None:
            raise ValueError('Open Viewer first.')
        for message in load_chat(self.run, paper_id)['messages']:
            if message['role'] == 'assistant' and message.get('in_reply_to') == in_reply_to:
                return message
        if self.responding.get(paper_id) != in_reply_to:
            raise ValueError('Read the pending chat before replying to this message.')
        message = append_message(self.run, paper_id, role='assistant', text=text,
                                 in_reply_to=in_reply_to, attachments=attachments, agent='Claude')
        self.responding.pop(paper_id, None)
        return message

    def status(self, paper_id: str) -> dict:
        """Report connection and actual message pickup, independently of delivery."""
        return {'agent': 'Claude', 'watching': self.connected,
                'responding_to': self.responding.get(paper_id) if self.connected else None}

    def notify(self, paper_id: str, message: dict) -> None:
        """Push a saved browser message from the HTTP thread without polling."""
        future = asyncio.run_coroutine_threadsafe(self._push(paper_id, message), self.loop)
        try:
            future.result(timeout=5)
        except Exception as exc:
            future.cancel()
            self.connected = False
            print(f'Viewer message saved; channel delivery failed: {exc}', file=sys.stderr)

    async def _push(self, paper_id: str, message: dict) -> None:
        # Claude's extension uses the SDK transport, outside its standard notification union.
        # https://code.claude.com/docs/en/channels-reference#notification-format
        event = types.JSONRPCNotification(jsonrpc='2.0', method='notifications/claude/channel', params={
            'content': 'New Viewer message. Use read_chat, then reply in Viewer.',
            'meta': {'paper_id': paper_id, 'message_id': message['id']},
        })
        await self.session.send_notification(event)  # type: ignore[arg-type]

    def close(self) -> None:
        """Close the reader when the host disconnects or opens another run."""
        self.connected = False
        self.responding.clear()
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.server = None


def main() -> None:
    """Serve three Viewer tools and Claude channel notifications over stdio."""
    channel = ViewerChannel()

    @asynccontextmanager
    async def lifespan(_server):
        try:
            yield
        finally:
            channel.close()

    async def capabilities(ctx, call_next):
        result = await call_next(ctx)
        if ctx.method == 'initialize':
            result['capabilities']['experimental'] = {'claude/channel': {}}
        return result

    mcp = MCPServer('crux-viewer', lifespan=lifespan, middleware=[capabilities], instructions=(
        'Use open_viewer to read a CRUX run or bare PDF folder with this session. '
        'Viewer chat arrives through this channel; do not run watch_chat.py or idle polling loops. '
        'On a channel event call read_chat once, inspect its source files and attachments, '
        'and respond with reply using the returned message ID. Screenshot file paths are relative '
        'to the returned run directory. Quote real sources, keep answers short, and use [[1]] '
        'for attached source quotations. Your normal terminal reply is not sent to Viewer. '
        'After replying, return to idle; the next message will arrive as another event.'
    ))
    mcp.tool()(channel.open_viewer)
    mcp.tool()(channel.read_chat)
    mcp.tool()(channel.reply)
    mcp.run()


if __name__ == '__main__':
    main()
