from __future__ import annotations

from dataclasses import dataclass

_LIGATURES = {
    '\ufb00': 'ff',
    '\ufb01': 'fi',
    '\ufb02': 'fl',
    '\ufb03': 'ffi',
    '\ufb04': 'ffl',
}
_HYPHENS = frozenset('-–—−\u00ad')
_QUOTES = {
    '\u2018': "'",
    '\u2019': "'",
    '\u2032': "'",
    '\u00b4': "'",
    '\u201c': '"',
    '\u201d': '"',
    '\u201e': '"',
    '\u2033': '"',
}


@dataclass(frozen=True)
class Span:
    start: int
    end: int


def _mapped(c: str) -> str:
    if c in _LIGATURES:
        return _LIGATURES[c]
    if c in _QUOTES:
        return _QUOTES[c]
    if c in _HYPHENS:
        return '-'
    return c.casefold()


def _fold(s: str, *, tight: bool, drop_hyphen: bool = False) -> tuple[str, list[int]]:
    folded: list[str] = []
    orig_at: list[int] = []
    i = 0
    n = len(s)
    pending_space = False
    started = False
    while i < n:
        c = s[i]
        if c in _HYPHENS and i + 1 < n and s[i + 1].isspace():
            if not drop_hyphen:
                folded.append('-')
                orig_at.append(i)
                started = True
            pending_space = False
            i += 1
            while i < n and s[i].isspace():
                i += 1
            continue
        if c.isspace():
            if started and not tight:
                pending_space = True
            i += 1
            continue
        if pending_space and not tight:
            folded.append(' ')
            orig_at.append(i)
            pending_space = False
        for ch in _mapped(c):
            if drop_hyphen and ch == '-':
                continue
            folded.append(ch)
            orig_at.append(i)
            started = True
        i += 1
    return ''.join(folded), orig_at


def find_quote(haystack: str, needle: str) -> Span | None:
    spans = find_all_quotes(haystack, needle)
    return spans[0] if spans else None


def find_all_quotes(haystack: str, needle: str) -> list[Span]:
    if not haystack or not needle or not str(needle).strip():
        return []
    for tight, drop_hyphen in (
        (False, False),
        (True, False),
        (False, True),
        (True, True),
    ):
        folded_h, hmap = _fold(haystack, tight=tight, drop_hyphen=drop_hyphen)
        folded_n, _ = _fold(needle, tight=tight, drop_hyphen=drop_hyphen)
        if not folded_n or not folded_h:
            continue
        spans: list[Span] = []
        start = 0
        while start <= len(folded_h) - len(folded_n):
            idx = folded_h.find(folded_n, start)
            if idx < 0:
                break
            spans.append(Span(hmap[idx], hmap[idx + len(folded_n) - 1] + 1))
            start = idx + max(1, len(folded_n))
        if spans:
            return spans
    return []
