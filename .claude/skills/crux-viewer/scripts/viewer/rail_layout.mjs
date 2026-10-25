export const RAIL_DEFAULT = 280;
export const RAIL_SNAP = 36;
export const STAGE_MIN = 240;

export function railCap(shellWidth) {
  return Math.max(0, Math.round(Number(shellWidth) || 0) - STAGE_MIN);
}

export function clampRailWidth(px, shellWidth) {
  const cap = railCap(shellWidth);
  const n = Math.max(0, Math.round(Number(px) || 0));
  if (cap <= 0) return n;
  return Math.min(cap, n);
}

export function defaultRailWidth(shellWidth) {
  const cap = railCap(shellWidth);
  if (cap <= 0) return RAIL_DEFAULT;
  return Math.min(RAIL_DEFAULT, cap);
}

export function stageWidth(railWidth, shellWidth) {
  return Math.max(0, Math.round(Number(shellWidth) || 0) - Math.round(Number(railWidth) || 0));
}
