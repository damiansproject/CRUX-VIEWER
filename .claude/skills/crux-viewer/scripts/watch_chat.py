#!/usr/bin/env python3
from __future__ import annotations

"""Poll or reply to the literature viewer chat mailbox.

The standalone server owns automatic model replies. This command supports
manual inspection/replies; ``--watch`` only prints pending messages.
"""

import argparse
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib.chat import append_message, pending_by_paper, touch_session


def main(argv: list[str] | None = None) -> int:
    """Poll the session mailbox or append a reply with optional source citations."""
    parser = argparse.ArgumentParser(description='Literature chat mailbox')
    parser.add_argument('--run', required=True, help='run directory')
    parser.add_argument('--once', action='store_true', help='heartbeat + print pending JSON')
    parser.add_argument('--watch', action='store_true', help='loop --once until interrupted')
    parser.add_argument('--interval', type=float, default=3.0)
    parser.add_argument('--reply', metavar='PAPER_ID', help='append an assistant reply')
    parser.add_argument('--text', default='', help='reply text (with --reply)')
    parser.add_argument('--attachments', type=Path, help='JSON file of source quotes; cite as [[1]], [[2]], ...')
    parser.add_argument('--in-reply-to', dest='in_reply_to', default=None)
    args = parser.parse_args(argv)
    run = Path(args.run)
    if args.reply:
        if not str(args.text).strip():
            print('error: --text required with --reply', file=sys.stderr)
            return 2
        msg = append_message(
            run,
            args.reply,
            role='assistant',
            text=args.text,
            in_reply_to=args.in_reply_to,
            attachments=json.loads(args.attachments.read_text(encoding='utf-8')) if args.attachments else None,
        )
        print(json.dumps(msg), flush=True)
        return 0
    if args.watch:
        try:
            while True:
                _print_once(run, responding=False)
                time.sleep(max(0.5, args.interval))
        except KeyboardInterrupt:
            return 0
    _print_once(run)
    return 0


def _print_once(run: Path, *, responding: bool = True) -> None:
    pending = pending_by_paper(run)
    touch_session(run, pending if responding else None)
    print(json.dumps({'pending': pending, 'watching': True}), flush=True)


if __name__ == '__main__':
    sys.exit(main())
