import { normalizeSpan } from "./user_marks.mjs";

export function menuActions(kind = "pdf", opts = {}) {
  if (kind === "box") {
    return [
      { id: "save-image", label: "Save image" },
      { id: "copy-image", label: "Copy image" },
      { id: "attach-image", label: "Attach image" },
    ];
  }
  const portal = opts.citations
    ? [{ id: "portal", label: opts.citations > 1 ? "Open cited paper…" : "Open cited paper" }]
    : [];
  const copyAttach = [
    { id: "copy", label: "Copy" },
    { id: "attach", label: "Attach to next message" },
  ];
  if (kind === "web" || kind === "mark") return [...portal, ...copyAttach];
  return [
    ...portal,
    { id: "highlight", label: "Highlight" },
    { id: "underline", label: "Underline" },
    ...copyAttach,
  ];
}

export function rightClickAction({ selectedType, onSelected, hasNative }) {
  if (onSelected && selectedType === "box") return "box";
  if (onSelected && selectedType) return "mark";
  if (hasNative) return "native";
  return null;
}

export function quoteFromSelection(text, page) {
  const body = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!body) return null;
  const n = Number(page);
  const out = { text: body };
  if (Number.isInteger(n) && n >= 1) out.page = n;
  return out;
}

export function quoteFromMark(haystack, mark) {
  if (!mark || (mark.type !== "highlight" && mark.type !== "underline")) return null;
  const start = Math.round(Number(mark.start));
  const end = Math.round(Number(mark.end));
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return quoteFromSelection(String(haystack || "").slice(start, end), mark.page);
}

export function cropBoxSource(cssBox, localW, localH, canvasW, canvasH) {
  const w = Number(localW);
  const h = Number(localH);
  const cw = Number(canvasW);
  const ch = Number(canvasH);
  const left = Number(cssBox?.left);
  const top = Number(cssBox?.top);
  const bw = Number(cssBox?.width);
  const bh = Number(cssBox?.height);
  if (![w, h, cw, ch, left, top, bw, bh].every(Number.isFinite)) return null;
  if (w < 1 || h < 1 || cw < 1 || ch < 1 || bw < 1 || bh < 1) return null;
  const sx = (left / w) * cw;
  const sy = (top / h) * ch;
  const sw = (bw / w) * cw;
  const sh = (bh / h) * ch;
  if (sw < 1 || sh < 1) return null;
  return { sx, sy, sw, sh };
}

export function parseAttachment(row) {
  if (!row || typeof row !== "object") return null;
  if (row.type === "image") {
    const data = typeof row.data === "string" && row.data.trim() ? row.data.trim() : "";
    const file = typeof row.file === "string" && row.file.trim() ? row.file.trim() : "";
    const name = typeof row.name === "string" && row.name.trim() ? row.name.trim() : "";
    if (!data && !file) return null;
    const out = { type: "image" };
    const n = Number(row.page);
    if (Number.isInteger(n) && n >= 1) out.page = n;
    if (row.paper_id) out.paper_id = row.paper_id;
    if (data) out.data = data;
    if (file) out.file = file;
    if (name) out.name = name;
    else if (file) out.name = file.split("/").pop();
    if (typeof row.markId === "string" && row.markId) out.markId = row.markId;
    return out;
  }
  const quote = quoteFromSelection(row.text, row.page);
  if (quote && row.paper_id) quote.paper_id = row.paper_id;
  return quote;
}

export function parseAttachments(rows) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const row of rows) {
    const next = parseAttachment(row);
    if (next) out.push(next);
    if (out.length >= 8) break;
  }
  return out;
}

export function addAttachment(list, quote) {
  const next = parseAttachment(quote);
  const cur = Array.isArray(list) ? list : [];
  if (!next) return cur;
  if (cur.some((row) => sameAttachment(row, next))) return cur;
  if (cur.length >= 8) return cur;
  return [...cur, next];
}

export function dropAttachment(list, index) {
  return (list || []).filter((_, i) => i !== index);
}

export function clipPreview(text, max = 72) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  const cap = Number(max);
  const n = Number.isFinite(cap) && cap > 1 ? cap : 72;
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

export function chipLabel(row, max = 56) {
  if (row?.type === "image") {
    const loc = row.page ? `p.${row.page} · ` : "";
    return loc + (row.name || "Box");
  }
  const loc = row.page ? `p.${row.page} · ` : "";
  return loc + clipPreview(row?.text, max);
}

// Where a citation-preview card sits relative to the selection it came from:
// above the anchor when there is room (falling below when there is not),
// horizontally centred on it, with the caret kept over the anchor.
export function portalPlacement(anchor, cardW, cardH, viewW, viewH, pad = 12) {
  const a = {
    left: Number(anchor?.left) || 0,
    right: Number(anchor?.right) || 0,
    top: Number(anchor?.top) || 0,
    bottom: Number(anchor?.bottom) || 0,
  };
  const gap = 10;
  const ax = Math.min(Math.max((a.left + a.right) / 2, pad), Math.max(pad, viewW - pad));
  const roomAbove = a.top - pad;
  const roomBelow = viewH - a.bottom - pad;
  let above;
  if (roomAbove >= cardH + gap) above = true;
  else if (roomBelow >= cardH + gap) above = false;
  else above = roomAbove >= roomBelow;
  let top = above ? a.top - cardH - gap : a.bottom + gap;
  top = Math.min(Math.max(pad, top), Math.max(pad, viewH - cardH - pad));
  const left = Math.min(Math.max(pad, ax - cardW / 2), Math.max(pad, viewW - cardW - pad));
  const caretX = Math.min(Math.max(18, ax - left), Math.max(18, cardW - 18));
  return { left, top, above, caretX };
}

export function clampMenuPos(x, y, menuW, menuH, viewW, viewH, pad = 8) {
  const p = Number(pad) || 0;
  const w = Number(menuW) || 0;
  const h = Number(menuH) || 0;
  const vw = Number(viewW) || 0;
  const vh = Number(viewH) || 0;
  return {
    left: Math.min(Math.max(p, vw - w - p), Math.max(p, Number(x) || 0)),
    top: Math.min(Math.max(p, vh - h - p), Math.max(p, Number(y) || 0)),
  };
}

export function domCharOffset(container, offset) {
  if (!container) return 0;
  if (container.nodeType === 3) return Math.max(0, Math.round(Number(offset) || 0));
  const kids = container.childNodes || [];
  const n = Math.max(0, Math.min(kids.length, Math.round(Number(offset) || 0)));
  let chars = 0;
  for (let i = 0; i < n; i++) {
    chars += String(kids[i].textContent || kids[i].nodeValue || "").length;
  }
  return chars;
}

export function haystackOffset(pairs, el, localOffset) {
  if (!el || !Array.isArray(pairs)) return null;
  const row = pairs.find((p) => p.el === el);
  if (!row) return null;
  const start = Number(row.range?.start);
  const end = Number(row.range?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const n = Math.round(Number(localOffset) || 0);
  return Math.min(end, Math.max(start, start + n));
}

export function spanFromDomRange(domRange, pairs, locateEl) {
  if (!domRange || typeof locateEl !== "function") return null;
  const start = haystackOffset(
    pairs,
    locateEl(domRange.startContainer),
    domCharOffset(domRange.startContainer, domRange.startOffset)
  );
  const end = haystackOffset(
    pairs,
    locateEl(domRange.endContainer),
    domCharOffset(domRange.endContainer, domRange.endOffset)
  );
  return normalizeSpan(start, end);
}

function sameAttachment(a, b) {
  if (a.paper_id !== b.paper_id) return false;
  if (a.type === "image" || b.type === "image") {
    if (a.type !== "image" || b.type !== "image") return false;
    if (a.markId && b.markId && a.markId === b.markId) return true;
    if (a.data && b.data && a.data === b.data) return true;
    if (a.file && b.file && a.file === b.file) return true;
    return false;
  }
  return a.text === b.text && a.page === b.page;
}

export function pngBlobFromDataUrl(dataUrl) {
  const match = String(dataUrl || "").match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return null;
  const bin = atob(match[1]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: "image/png" });
}

export function clipboardPngItems(blob) {
  if (!blob) return null;
  return { "image/png": Promise.resolve(blob) };
}
