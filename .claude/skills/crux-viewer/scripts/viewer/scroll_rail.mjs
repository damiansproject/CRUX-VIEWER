const LINEAR_PAGES = 10;
const LENS_POWER = 0.6;

function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

function warp(page, focus) {
  const d = page - focus;
  const ad = Math.abs(d);
  if (ad <= LINEAR_PAGES) return d;
  return Math.sign(d) * (LINEAR_PAGES + Math.log1p(ad - LINEAR_PAGES));
}

function unwarp(w) {
  const aw = Math.abs(w);
  if (aw <= LINEAR_PAGES) return w;
  return Math.sign(w) * (LINEAR_PAGES + Math.expm1(aw - LINEAR_PAGES));
}

export function pageToT(page, focus, n) {
  if (n <= 1) return 0;
  const w = warp(page, focus);
  const lo = warp(1, focus);
  const hi = warp(n, focus);
  if (hi === lo) return 0;
  return (w - lo) / (hi - lo);
}

export function tToPage(t, focus, n) {
  if (n <= 1) return 1;
  const lo = warp(1, focus);
  const hi = warp(n, focus);
  const w = lo + clamp(t, 0, 1) * (hi - lo);
  return clamp(focus + unwarp(w), 1, n);
}

function lensFn(h, p) {
  return (x) => {
    const d = x - h;
    if (d === 0) return h;
    return h + Math.sign(d) * Math.pow(Math.abs(d), p);
  };
}

export function applyLens(t, hoverT, strength) {
  const s = clamp(strength, 0, 1);
  if (s <= 0) return t;
  const h = clamp(hoverT, 0, 1);
  const f = lensFn(h, 1 - LENS_POWER * s);
  const f0 = f(0);
  const span = f(1) - f0;
  if (Math.abs(span) < 1e-12) return t;
  return (f(clamp(t, 0, 1)) - f0) / span;
}

export function undoLens(u, hoverT, strength) {
  const s = clamp(strength, 0, 1);
  if (s <= 0) return u;
  const h = clamp(hoverT, 0, 1);
  const p = 1 - LENS_POWER * s;
  const f = lensFn(h, p);
  const f0 = f(0);
  const target = f0 + clamp(u, 0, 1) * (f(1) - f0);
  const dOut = target - h;
  if (dOut === 0) return h;
  return h + Math.sign(dOut) * Math.pow(Math.abs(dOut), 1 / p);
}

export function mapPage(page, { focus, n, hoverT = 0.5, lens = 0 } = {}) {
  return applyLens(pageToT(page, focus, n), hoverT, lens);
}

export function unmapT(t, { focus, n, hoverT = 0.5, lens = 0 } = {}) {
  return tToPage(undoLens(t, hoverT, lens), focus, n);
}

export function pageCoord(page, along, total) {
  const p = Number(page);
  if (!Number.isFinite(p) || p < 1) return 1;
  const t = Number(total);
  const a = Number(along);
  if (!(t > 0) || !Number.isFinite(a)) return p;
  return p + Math.min(0.999, Math.max(0, a / t));
}
