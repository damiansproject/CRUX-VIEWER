"""Locate a claim's quotes in the converted source text and return surrounding context.

The claims pane shows a card per claim; expanding one needs the full quote plus the
sentences around it, which live in ``cleaned_jsons/<paper_id>.json`` (the converted
source) rather than in the claim row. Missing or unconverted sources degrade to the
stored quote with no context.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from lib.match_text import find_quote

WINDOW = 420


def _cleaned_pages(run_dir: Path, paper_id: str) -> list[dict[str, Any]]:
    path = run_dir / 'cleaned_jsons' / f'{paper_id}.json'
    if not path.is_file():
        return []
    try:
        data = json.loads(path.read_text(encoding='utf-8'))
    except (json.JSONDecodeError, OSError):
        return []
    pages = data.get('pages')
    return [p for p in pages if isinstance(p, dict)] if isinstance(pages, list) else []


def _locate(pages: list[dict[str, Any]], text: str, hint: object) -> dict[str, Any] | None:
    """Find text in the page whose number is hinted, else anywhere in the source."""
    ordered = list(pages)
    if isinstance(hint, int):
        ordered.sort(key=lambda p: p.get('page') != hint)
    for page in ordered:
        body = page.get('text')
        if not isinstance(body, str) or not body:
            continue
        span = find_quote(body, text)
        if not span:
            continue
        return {
            'page': page.get('page'),
            'before': body[max(0, span.start - WINDOW):span.start].lstrip(),
            'text': body[span.start:span.end],
            'after': body[span.end:span.end + WINDOW].rstrip(),
        }
    return None


def claim_context(run_dir: Path | str, claim: dict[str, Any]) -> dict[str, Any]:
    """Quotes of one claim, each with surrounding source text when it can be found."""
    run_dir = Path(run_dir)
    paper_id = claim.get('paper_id')
    pages = _cleaned_pages(run_dir, paper_id) if isinstance(paper_id, str) else []
    quotes: list[dict[str, Any]] = []
    for quote in claim.get('quotes') or []:
        if not isinstance(quote, dict):
            continue
        text = quote.get('text')
        if not isinstance(text, str) or not text.strip():
            continue
        locator = quote.get('locator') if isinstance(quote.get('locator'), dict) else {}
        page_hint = locator.get('page')
        found = _locate(pages, text, page_hint) if pages else None
        quotes.append({
            'text': text,
            'page': (found or {}).get('page', page_hint),
            'before': (found or {}).get('before', ''),
            'after': (found or {}).get('after', ''),
            'located': found is not None,
        })
    return {
        'claim_id': claim.get('id'),
        'paper_id': paper_id,
        'kind': claim.get('kind'),
        'statement': claim.get('statement'),
        'source': claim.get('source') if isinstance(claim.get('source'), dict) else {},
        'quotes': quotes,
        'has_source_text': bool(pages),
    }
