const LIGATURES = {
  "\uFB00": "ff",
  "\uFB01": "fi",
  "\uFB02": "fl",
  "\uFB03": "ffi",
  "\uFB04": "ffl",
};

function mappedChars(c) {
  if (LIGATURES[c]) return LIGATURES[c];
  if (c === "\u2018" || c === "\u2019" || c === "\u2032" || c === "\u00B4") return "'";
  if (c === "\u201C" || c === "\u201D" || c === "\u201E" || c === "\u2033") return '"';
  if (c === "\u2013" || c === "\u2014" || c === "\u2212" || c === "\u00AD") return "-";
  return c.toLocaleLowerCase();
}

function foldOpts(opts) {
  if (opts === true || opts === false) return { tight: opts, dropHyphen: false };
  return { tight: Boolean(opts?.tight), dropHyphen: Boolean(opts?.dropHyphen) };
}

export function fold(s, opts = false) {
  const { tight, dropHyphen } = foldOpts(opts);
  const out = [];
  const orig = [];
  let i = 0;
  let pendingSpace = false;
  let started = false;
  while (i < s.length) {
    const c = s[i];
    const hyphen = c === "-" || c === "\u2013" || c === "\u2014" || c === "\u2212" || c === "\u00AD";
    if (hyphen && i + 1 < s.length && /\s/.test(s[i + 1])) {
      if (!dropHyphen) {
        out.push("-");
        orig.push(i);
        started = true;
      }
      pendingSpace = false;
      i += 1;
      while (i < s.length && /\s/.test(s[i])) i += 1;
      continue;
    }
    if (/\s/.test(c)) {
      if (started && !tight) pendingSpace = true;
      i += 1;
      continue;
    }
    if (pendingSpace && !tight) {
      out.push(" ");
      orig.push(i);
      pendingSpace = false;
    }
    for (const ch of mappedChars(c)) {
      if (dropHyphen && ch === "-") continue;
      out.push(ch);
      orig.push(i);
      started = true;
    }
    i += 1;
  }
  return { folded: out.join(""), orig };
}

export function findQuote(haystack, needle) {
  const hits = findAllQuotes(haystack, needle);
  return hits[0] || null;
}

export function findAllQuotes(haystack, needle) {
  if (!haystack || !needle || !String(needle).trim()) return [];
  const modes = [
    { tight: false, dropHyphen: false },
    { tight: true, dropHyphen: false },
    { tight: false, dropHyphen: true },
    { tight: true, dropHyphen: true },
  ];
  for (const mode of modes) {
    const h = fold(haystack, mode);
    const n = fold(needle, mode).folded;
    if (!n || !h.folded) continue;
    const hits = [];
    let from = 0;
    while (from <= h.folded.length - n.length) {
      const idx = h.folded.indexOf(n, from);
      if (idx < 0) break;
      hits.push({ start: h.orig[idx], end: h.orig[idx + n.length - 1] + 1 });
      from = idx + Math.max(1, n.length);
    }
    if (hits.length) return hits;
  }
  return [];
}
