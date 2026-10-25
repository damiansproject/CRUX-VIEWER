export const INKS = ["yellow", "mint", "sky", "pink", "violet"];

export function cycleInk(ink) {
  const i = INKS.indexOf(ink);
  return INKS[(((i < 0 ? 0 : i) + 1) % INKS.length)];
}

export function normalizeSpan(start, end) {
  const a = Math.round(Number(start));
  const b = Math.round(Number(end));
  if (!Number.isFinite(a) || !Number.isFinite(b) || a === b) return null;
  return a < b ? { start: a, end: b } : { start: b, end: a };
}

export function boxFromPoints(x0, y0, x1, y1) {
  const xs = [Number(x0), Number(x1)];
  const ys = [Number(y0), Number(y1)];
  if (xs.some((n) => !Number.isFinite(n)) || ys.some((n) => !Number.isFinite(n))) return null;
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  if (right - left < 1 || bottom - top < 1) return null;
  return { x1: left, y1: top, x2: right, y2: bottom };
}

export function runAxis(alongX, alongY) {
  const ax = Number(alongX) || 0;
  const ay = Number(alongY) || 0;
  if (Math.abs(ax) >= Math.abs(ay)) return ax < 0 ? "x-reverse" : "x";
  return ay < 0 ? "y-reverse" : "y";
}

export function clipRangeRect(rect, rangeStart, rangeEnd, spanStart, spanEnd, axis = "x") {
  const len = rangeEnd - rangeStart;
  if (!rect || len <= 0 || rect.width < 1 || rect.height < 1) return null;
  const from = Math.max(rangeStart, spanStart);
  const to = Math.min(rangeEnd, spanEnd);
  if (to <= from) return null;
  const t0 = (from - rangeStart) / len;
  const dt = (to - from) / len;
  if (axis === "y") {
    return {
      left: rect.left,
      top: rect.top + t0 * rect.height,
      width: rect.width,
      height: dt * rect.height,
    };
  }
  if (axis === "x-reverse") {
    return {
      left: rect.left + (1 - t0 - dt) * rect.width,
      top: rect.top,
      width: dt * rect.width,
      height: rect.height,
    };
  }
  if (axis === "y-reverse") {
    return {
      left: rect.left,
      top: rect.top + (1 - t0 - dt) * rect.height,
      width: rect.width,
      height: dt * rect.height,
    };
  }
  return {
    left: rect.left + t0 * rect.width,
    top: rect.top,
    width: dt * rect.width,
    height: rect.height,
  };
}

export function underlineMarkRect(rect, { gap = 2, thickness = 2.5, upX = 0, upY = -1 } = {}) {
  if (!rect) return null;
  const ux = Number(upX) || 0;
  const uy = Number(upY) || 0;
  if (Math.abs(uy) >= Math.abs(ux)) {
    if (uy <= 0) {
      return {
        left: rect.left,
        top: rect.top + rect.height + gap,
        width: rect.width,
        height: thickness,
      };
    }
    return {
      left: rect.left,
      top: rect.top - gap - thickness,
      width: rect.width,
      height: thickness,
    };
  }
  if (ux <= 0) {
    return {
      left: rect.left + rect.width + gap,
      top: rect.top,
      width: thickness,
      height: rect.height,
    };
  }
  return {
    left: rect.left - gap - thickness,
    top: rect.top,
    width: thickness,
    height: rect.height,
  };
}

export function clientToLocal(bounds, localW, localH, clientX, clientY) {
  const w = Number(localW) || 0;
  const h = Number(localH) || 0;
  const bw = Number(bounds?.width) || 0;
  const bh = Number(bounds?.height) || 0;
  if (!w || !h || !bw || !bh) {
    return { x: clientX - (bounds?.left || 0), y: clientY - (bounds?.top || 0) };
  }
  return {
    x: ((clientX - bounds.left) / bw) * w,
    y: ((clientY - bounds.top) / bh) * h,
  };
}

export function itemCharSlices(ranges, span) {
  const start = Number(span?.start);
  const end = Number(span?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Array.isArray(ranges)) {
    return [];
  }
  const out = [];
  let spanI = 0;
  for (const r of ranges) {
    if (!r || r.start === r.end) continue;
    if (!(r.end <= start || r.start >= end)) {
      const from = Math.max(r.start, start) - r.start;
      const to = Math.min(r.end, end) - r.start;
      if (to > from) out.push({ spanI, from, to });
    }
    spanI += 1;
  }
  return out;
}

export function clientRectsToLocal(bounds, localW, localH, rects) {
  const out = [];
  for (const r of rects || []) {
    if (!r || r.width < 0.5 || r.height < 0.5) continue;
    const p0 = clientToLocal(bounds, localW, localH, r.left, r.top);
    const p1 = clientToLocal(bounds, localW, localH, r.right, r.bottom);
    const width = p1.x - p0.x;
    const height = p1.y - p0.y;
    if (width < 0.5 || height < 0.5) continue;
    out.push({ left: p0.x, top: p0.y, width, height });
  }
  return out;
}

export function shiftCssBox(box, dx, dy, bounds) {
  const width = Number(box?.width) || 0;
  const height = Number(box?.height) || 0;
  const maxX = Math.max(0, (Number(bounds?.width) || 0) - width);
  const maxY = Math.max(0, (Number(bounds?.height) || 0) - height);
  return {
    left: Math.min(maxX, Math.max(0, (Number(box?.left) || 0) + (Number(dx) || 0))),
    top: Math.min(maxY, Math.max(0, (Number(box?.top) || 0) + (Number(dy) || 0))),
    width,
    height,
  };
}

export function textLayerTransform(rotation) {
  const rot = ((Math.round(Number(rotation) || 0) % 360) + 360) % 360;
  if (rot === 90) return "rotate(90deg) translateY(-100%)";
  if (rot === 180) return "rotate(180deg) translate(-100%, -100%)";
  if (rot === 270) return "rotate(270deg) translateX(-100%)";
  return "";
}

export function parseMarks(raw) {
  if (!raw || !Array.isArray(raw.marks)) return [];
  const out = [];
  for (const row of raw.marks) {
    const mark = parseMark(row);
    if (mark) out.push(mark);
  }
  return out;
}

export function newMarkId() {
  return `um-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function parseMark(row) {
  if (!row || typeof row !== "object") return null;
  if (typeof row.id !== "string" || !row.id) return null;
  const page = Number(row.page);
  if (!Number.isInteger(page) || page < 1) return null;
  if (!INKS.includes(row.ink)) return null;
  if (row.type === "highlight" || row.type === "underline") {
    const span = normalizeSpan(row.start, row.end);
    if (!span) return null;
    return { id: row.id, type: row.type, page, ink: row.ink, start: span.start, end: span.end };
  }
  if (row.type === "box") {
    const box = boxFromPoints(row.x1, row.y1, row.x2, row.y2);
    if (!box) return null;
    return { id: row.id, type: "box", page, ink: row.ink, ...box };
  }
  return null;
}
