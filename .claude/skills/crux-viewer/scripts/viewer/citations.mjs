import { findAllQuotes, fold } from "./match.js";

// Citation portals: parse citation markers out of a selection, resolve them to
// reference entries in this paper's bibliography, match those against the
// catalog, and score the most relevant passage of the cited paper. Everything
// here is pure so node can test it without a DOM.

const YEAR = /\b(1[89]\d{2}|20\d{2})[a-z]?\b/;
const NUM_GROUP =
  /\[(\d{1,4}(?:\s*[–—-]\s*\d{1,4})?(?:\s*[,;]\s*\d{1,4}(?:\s*[–—-]\s*\d{1,4})?)*)\]/g;
const NARRATIVE =
  /\b([A-Z][\p{L}'’-]+)(?:\s+(?:et al\.?|and\s+[A-Z][\p{L}'’-]+|&\s*[A-Z][\p{L}'’-]+))?\s*\((\d{4})[a-z]?\)/gu;
const PAREN = /\(([^()]{2,240})\)/g;
const PAREN_SEG =
  /([A-Z][\p{L}'’-]+)(?:\s*,?\s*(?:et al\.?|&\s*[A-Z][\p{L}'’-]+|and\s+[A-Z][\p{L}'’-]+))?\s*,?\s*(\d{4})[a-z]?(?:\s*,\s*pp?\.?\s*\d+(?:\s*[–—-]\s*\d+)?)?\s*$/u;
// "et al." is citation-specific enough to trust without balanced parentheses,
// which selections cut through all the time ("…helpful (Askell et al., 2021;").
const ETAL = /\b([A-Z][\p{L}'’-]+)\s*,?\s+et al\.?,?\s*\(?(\d{4})[a-z]?/gu;

const TITLE_STOP = new Set([
  "with", "from", "into", "this", "that", "then", "than", "them", "they",
  "their", "have", "been", "were", "about", "using", "based", "toward", "towards",
  "arxiv", "preprint",
]);

const QUERY_STOP = new Set([
  "about", "after", "which", "while", "these", "those", "their", "there",
  "where", "using", "based", "between", "because", "under", "over", "from",
  "with", "that", "this", "have", "been", "were", "when", "then", "than",
  "them", "they", "also", "only", "such", "some", "most", "more", "much",
  "many", "each", "other", "into", "through", "paper", "papers", "model",
  "models", "method", "methods", "result", "results", "shows", "shown",
  "propose", "proposed", "approach", "study", "studies", "works", "present",
  "presents", "prior", "recent", "several",
]);

function saneYear(y) {
  const n = Number(y);
  return Number.isInteger(n) && n >= 1800 && n <= 2100;
}

function expandNumbers(group) {
  const out = [];
  for (const part of group.split(/[,;]/)) {
    const m = part.match(/(\d{1,4})(?:\s*[–—-]\s*(\d{1,4}))?/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] != null ? Number(m[2]) : a;
    if (b >= a && b - a <= 24) {
      for (let n = a; n <= b; n++) out.push(n);
    } else {
      out.push(a, b);
    }
  }
  return out;
}

function citeKey(cite) {
  return cite.kind === "num" ? `n:${cite.n}` : `a:${fold(cite.author).folded}:${cite.year}`;
}

function dedupeCites(cites, cap = 12) {
  const out = [];
  const seen = new Set();
  for (const cite of cites) {
    const key = citeKey(cite);
    if (seen.has(key) || out.length >= cap) continue;
    seen.add(key);
    out.push(cite);
  }
  return out;
}

/** Locate individual citation markers; a printed numeric range keeps its member citations. */
export function citationSpans(text, cap = 40) {
  const s = String(text || "");
  const raw = [];
  let m;
  NUM_GROUP.lastIndex = 0;
  while ((m = NUM_GROUP.exec(s))) {
    for (const part of m[1].matchAll(/\d+(?:\s*[–—-]\s*\d+)?/g)) {
      const cites = expandNumbers(part[0])
        .filter((n) => n >= 1 && n <= 2000)
        .map((n) => ({ kind: "num", n }));
      const start = m.index + 1 + part.index;
      if (cites.length) raw.push({ start, end: start + part[0].length, cites });
    }
  }
  PAREN.lastIndex = 0;
  while ((m = PAREN.exec(s))) {
    if (!YEAR.test(m[1])) continue;
    for (const segment of m[1].matchAll(/[^;]+/g)) {
      const sm = segment[0].match(PAREN_SEG);
      if (!sm || !saneYear(sm[2])) continue;
      const start = m.index + 1 + segment.index + sm.index;
      raw.push({ start, end: start + sm[0].trimEnd().length,
        cites: [{ kind: "ay", author: sm[1], year: sm[2] }] });
    }
  }
  NARRATIVE.lastIndex = 0;
  while ((m = NARRATIVE.exec(s))) {
    if (saneYear(m[2])) {
      raw.push({
        start: m.index,
        end: m.index + m[0].length,
        cites: [{ kind: "ay", author: m[1], year: m[2] }],
      });
    }
  }
  ETAL.lastIndex = 0;
  while ((m = ETAL.exec(s))) {
    if (saneYear(m[2])) {
      raw.push({
        start: m.index,
        end: m.index + m[0].length,
        cites: [{ kind: "ay", author: m[1], year: m[2] }],
      });
    }
  }
  raw.sort((a, b) => a.start - b.start || b.end - a.end);
  const zones = [];
  for (const row of raw) {
    const last = zones[zones.length - 1];
    if (last && row.start < last.end) {
      last.end = Math.max(last.end, row.end);
      last.cites = dedupeCites([...last.cites, ...row.cites]);
      continue;
    }
    if (zones.length >= cap) break;
    zones.push({ start: row.start, end: row.end, cites: dedupeCites(row.cites) });
  }
  return zones;
}

export function parseCitations(text, cap = 12) {
  return dedupeCites(citationSpans(text).flatMap((z) => z.cites), cap);
}

// The sentence a citation marker sits in, for the model to match against —
// bounded so a run-on abstract cannot flood the prompt.
export function sentenceAround(text, start, end, max = 420) {
  const s = String(text || "");
  const from = Math.max(0, Math.min(start, s.length));
  const to = Math.max(from, Math.min(end, s.length));
  const stop = (i) =>
    /[.!?]/.test(s[i]) &&
    /\s/.test(s[i + 1] || " ") &&
    !/[A-Z]/.test(s[i - 1] || "") &&
    s.slice(Math.max(0, i - 2), i) !== "al";
  let a = from;
  while (a > 0 && from - a < max / 2 && !stop(a - 1)) a -= 1;
  let b = to;
  while (b < s.length && b - to < max / 2) {
    b += 1;
    if (stop(b - 1)) break;
  }
  return s.slice(a, b).trim();
}

// The bibliography starts at a capitalized heading followed by year-dense
// text. Position in the document is no signal — long papers put References
// before fifty pages of appendix — so among candidate headings the one with
// the most years in the following stretch wins (entries are year-dense in a
// way prose mentions of "References" never are). Returns the 1-based page
// the heading is on, its char offset within that page, and its offset in the
// newline-joined full text.
export function referencesStart(pageTexts) {
  const pages = (pageTexts || []).map((t) => String(t || ""));
  const full = pages.join("\n");
  if (!full) return null;
  // "R EFERENCES": small-caps headings extract with the tall initial split off.
  const re =
    /\b(R\s?EFERENCES|References|B\s?IBLIOGRAPHY|Bibliography|W\s?ORKS\s+C\s?ITED|Works Cited|L\s?ITERATURE\s+C\s?ITED|Literature Cited)\b/g;
  let best = null;
  let m;
  while ((m = re.exec(full))) {
    const after = full.slice(m.index, m.index + 1500);
    const years = (after.match(/\b(1[89]\d{2}|20\d{2})\b/g) || []).length;
    if (years >= 3 && (!best || years > best.years)) best = { index: m.index, years };
  }
  if (!best) return null;
  let bound = 0;
  for (let i = 0; i < pages.length; i++) {
    const end = bound + pages[i].length;
    if (best.index <= end) return { page: i + 1, offset: best.index - bound, index: best.index };
    bound = end + 1;
  }
  return { page: pages.length, offset: 0, index: best.index };
}

export function referencesText(pageTexts) {
  const start = referencesStart(pageTexts);
  if (!start) return null;
  return (pageTexts || []).map((t) => String(t || "")).join("\n").slice(start.index);
}

export function entryForNumeric(refs, n) {
  if (!refs) return null;
  const m = new RegExp(`\\[\\s*${Number(n)}\\s*\\]`).exec(refs);
  if (!m) return null;
  const start = m.index + m[0].length;
  const next = /\[\s*\d{1,4}\s*\]/g;
  next.lastIndex = start;
  const nm = next.exec(refs);
  const end = Math.min(nm ? nm.index : refs.length, start + 600);
  const entry = refs.slice(start, end).trim();
  return entry || null;
}

// The window must survive huge author lists (15+ names) with the title and
// identifiers still inside it…
const ENTRY_WINDOW = 560;

// …but stop at the entry's end — author-year entries close with "…, 2021." —
// or the window bleeds into the next entry and poisons catalog matching.
export function trimEntry(raw) {
  const s = String(raw || "");
  const re = /\b(?:1[89]|20)\d{2}[a-z]?\s*\.(?=\s|$)/g;
  let m;
  while ((m = re.exec(s))) {
    if (m.index >= 60) return s.slice(0, m.index + m[0].length);
  }
  return s;
}

// A surname can appear as a co-author in several entries before the one it
// leads (alphabetical bibliographies). Among occurrences whose entry carries
// the right year, prefer the one sitting right after an entry boundary — a
// closing "…, 2021." or an "…arxiv.org/abs/… ." — that one is the first
// author of its own entry.
const ENTRY_BOUNDARY = /\b(?:1[89]|20)\d{2}[a-z]?\s*\.|\barxiv\.org\/\S+\s*\./gi;

export function entryForAuthorYear(refs, author, year) {
  if (!refs) return null;
  const a = fold(String(author || "")).folded;
  if (!a) return null;
  const h = fold(refs);
  const candidates = [];
  let from = 0;
  while (true) {
    const i = h.folded.indexOf(a, from);
    if (i < 0) break;
    from = i + 1;
    const bounded =
      (i === 0 || !/[a-z0-9]/.test(h.folded[i - 1])) &&
      !/[a-z0-9]/.test(h.folded[i + a.length] || " ");
    if (!bounded) continue;
    const s = h.orig[i];
    const last = Math.min(h.orig.length - 1, i + ENTRY_WINDOW);
    const entry = trimEntry(refs.slice(s, h.orig[last] + 1));
    if (!fold(entry).folded.includes(String(year))) continue;
    const before = refs.slice(Math.max(0, s - 300), s);
    let lead = s <= 300 ? s : 999;
    ENTRY_BOUNDARY.lastIndex = 0;
    let m;
    while ((m = ENTRY_BOUNDARY.exec(before))) {
      lead = before.length - (m.index + m[0].length);
    }
    candidates.push({ lead, entry });
  }
  if (!candidates.length) return null;
  candidates.sort((x, y) => x.lead - y.lead);
  return candidates[0].entry;
}

export function titleTokens(title) {
  const raw = fold(String(title || "")).folded.split(/[^a-z0-9]+/).filter(Boolean);
  const out = [];
  for (const tok of raw) {
    if (/^\d+$/.test(tok) && !/^(1[89]|20)\d{2}$/.test(tok)) continue;
    if (tok.length < 4 || TITLE_STOP.has(tok) || out.includes(tok)) continue;
    out.push(tok);
  }
  return out;
}

function hasToken(hay, tok) {
  let from = 0;
  while (true) {
    const i = hay.indexOf(tok, from);
    if (i < 0) return false;
    const bounded =
      (i === 0 || !/[a-z0-9]/.test(hay[i - 1])) &&
      !/[a-z0-9]/.test(hay[i + tok.length] || " ");
    if (bounded) return true;
    from = i + 1;
  }
}

// Reference entries quote the cited title nearly verbatim, so a paper whose
// title tokens mostly appear in the entry is the cited paper.
export function matchCatalog(entryText, papers, { selfId } = {}) {
  const hay = fold(String(entryText || "")).folded;
  if (!hay) return null;
  let best = null;
  for (const p of papers || []) {
    if (!p || p.paper_id === selfId) continue;
    const tokens = titleTokens(p.title || p.paper_id);
    // one usable token (e.g. a grabbed "arXiv_2502_17424") is no basis for a
    // title match — such papers are only reachable through the model resolver
    if (tokens.length < 2) continue;
    let matched = 0;
    for (const tok of tokens) if (hasToken(hay, tok)) matched += 1;
    const score = matched / tokens.length;
    if (matched < 2 || score < 0.6) continue;
    if (!best || score > best.score || (score === best.score && matched > best.matched)) {
      best = { paper: p, score, matched };
    }
  }
  return best ? best.paper : null;
}

// What to search for in the cited paper: the citing passage minus its markers.
export function citationQuery(text, max = 380) {
  let s = String(text || "");
  NUM_GROUP.lastIndex = 0;
  s = s.replace(NUM_GROUP, " ");
  s = s.replace(PAREN, (m, body) => (YEAR.test(body) ? " " : m));
  s = s.replace(/\bet al\.?/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max) : s;
}

export function quotedPhrases(text) {
  const out = [];
  const re = /["“”']([^"“”']{12,240})["“”']/g;
  let m;
  while ((m = re.exec(String(text || "")))) {
    const s = m[1].trim();
    if (s) out.push(s);
  }
  return out;
}

export function queryTerms(query, cap = 24) {
  const raw = fold(String(query || "")).folded.split(/[^a-z0-9]+/).filter(Boolean);
  const out = [];
  for (const tok of raw) {
    if (tok.length < 4 || QUERY_STOP.has(tok) || out.includes(tok)) continue;
    out.push(tok);
    if (out.length >= cap) break;
  }
  return out;
}

function stemOf(term) {
  if (term.length >= 6 && term.endsWith("es")) return term.slice(0, -2);
  if (term.length >= 5 && term.endsWith("s")) return term.slice(0, -1);
  return term;
}

// A term matches any token that starts with its stem and runs at most two
// characters longer, so "vectors" finds "vector" and vice versa.
function termEvents(folded, terms) {
  const events = [];
  const seen = new Set();
  for (const term of terms) {
    const stem = stemOf(term);
    if (seen.has(stem)) continue;
    seen.add(stem);
    let from = 0;
    while (true) {
      const i = folded.indexOf(stem, from);
      if (i < 0) break;
      from = i + stem.length;
      if (i > 0 && /[a-z0-9]/.test(folded[i - 1])) continue;
      let end = i + stem.length;
      while (end < folded.length && /[a-z0-9]/.test(folded[end])) end += 1;
      if (end - (i + stem.length) > 2) continue;
      events.push({ pos: i, len: end - i, term: stem, w: Math.min(term.length, 12) });
    }
  }
  return events.sort((a, b) => a.pos - b.pos);
}

// Candidate pages to send to the model when the heuristic has no exact hit:
// the most term-dense pages plus page 1 (title and abstract anchor the model),
// ascending page order, each trimmed. All zeros degrades to the first pages.
export function rankPagesForLocate(pageTexts, query, { cap = 12, maxChars = 4000 } = {}) {
  const pages = (pageTexts || []).map((t) => String(t || ""));
  const terms = queryTerms(query);
  const rows = pages.map((text, i) => {
    const events = terms.length && text ? termEvents(fold(text).folded, terms) : [];
    const distinct = new Set(events.map((e) => e.term)).size;
    return { n: i + 1, text, score: distinct * 100 + Math.min(events.length, 50) };
  });
  const keep = new Set(
    [...rows].sort((a, b) => b.score - a.score || a.n - b.n).slice(0, cap).map((r) => r.n)
  );
  keep.add(1);
  return rows
    .filter((r) => keep.has(r.n) && r.text.trim())
    .slice(0, cap + 1)
    .map((r) => ({ n: r.n, text: r.text.slice(0, maxChars) }));
}

// Best passage of the cited paper for a citing passage: an exact hit on any
// quoted phrase wins; otherwise the window with the densest cluster of the
// query's significant terms. Pages are 1-based like everywhere else.
export function bestPassage(pageTexts, query, { window = 700 } = {}) {
  const pages = (pageTexts || []).map((t) => String(t || ""));
  for (const phrase of quotedPhrases(query)) {
    for (let i = 0; i < pages.length; i++) {
      const hits = findAllQuotes(pages[i], phrase);
      if (hits.length) return { page: i + 1, spans: [hits[0]], matched: 1, exact: true };
    }
  }
  const terms = queryTerms(query);
  if (terms.length < 2) return null;
  let best = null;
  for (let i = 0; i < pages.length; i++) {
    const h = fold(pages[i]);
    const events = termEvents(h.folded, terms);
    let j = 0;
    for (let k = 0; k < events.length; k++) {
      while (events[k].pos - events[j].pos > window) j += 1;
      const seen = new Set();
      let score = 0;
      for (let x = j; x <= k; x++) {
        const ev = events[x];
        if (seen.has(ev.term)) score += ev.w * 0.1;
        else {
          seen.add(ev.term);
          score += ev.w;
        }
      }
      if (!best || score > best.score) {
        best = { page: i + 1, score, distinct: seen.size, events: events.slice(j, k + 1), h };
      }
    }
  }
  if (!best || best.distinct < 2) return null;
  const spans = [];
  const seenSpan = new Set();
  for (const ev of best.events) {
    const start = best.h.orig[ev.pos];
    const end = best.h.orig[ev.pos + ev.len - 1] + 1;
    const key = `${start}:${end}`;
    if (seenSpan.has(key)) continue;
    seenSpan.add(key);
    spans.push({ start, end });
  }
  spans.sort((a, b) => a.start - b.start);
  return { page: best.page, spans, matched: best.distinct, exact: false };
}
