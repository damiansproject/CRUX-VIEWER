import assert from "node:assert/strict";
import { test } from "node:test";
import {
  applyLens,
  mapPage,
  pageCoord,
  pageToT,
  tToPage,
  undoLens,
  unmapT,
} from "../.claude/skills/crux-viewer/scripts/viewer/scroll_rail.mjs";

test("current page sits near the middle so nearby pages stay reachable", () => {
  const n = 300;
  assert.equal(pageToT(1, 1, n), 0);
  assert.equal(pageToT(n, n, n), 1);
  const t20 = pageToT(20, 20, n);
  const linear20 = 19 / 299;
  assert.ok(t20 > 0.35 && t20 < 0.65, `focus 20 at ${t20}`);
  assert.ok(t20 > linear20 * 4);
  const nearby = pageToT(20, 20, n) - pageToT(15, 20, n);
  assert.ok(nearby > 5 / 299 * 8, nearby);
  const mid = pageToT(150, 150, n);
  assert.ok(Math.abs(mid - 0.5) < 0.02, mid);
});

test("track is linear within ten pages of focus", () => {
  const n = 200;
  const focus = 50;
  const a = pageToT(50, focus, n) - pageToT(45, focus, n);
  const b = pageToT(45, focus, n) - pageToT(40, focus, n);
  assert.ok(Math.abs(a - b) < 1e-9);
});

test("pages beyond ten compress relative to the linear band", () => {
  const n = 200;
  const focus = 50;
  const linear = pageToT(60, focus, n) - pageToT(50, focus, n);
  const compressed = pageToT(90, focus, n) - pageToT(80, focus, n);
  assert.ok(linear > compressed);
});

test("page mapping round-trips through the track", () => {
  const n = 80;
  for (const focus of [1, 12.4, 40, 80]) {
    for (const page of [1, 2, 40, 79, 80]) {
      const back = tToPage(pageToT(page, focus, n), focus, n);
      assert.ok(Math.abs(back - page) < 1e-6, `${page} @ ${focus} -> ${back}`);
    }
  }
});

test("lens expands around the hover and still inverts", () => {
  const hover = 0.42;
  const strength = 1;
  const near = Math.abs(applyLens(hover + 0.02, hover, strength) - applyLens(hover, hover, strength));
  const far = Math.abs(applyLens(0.98, hover, strength) - applyLens(0.9, hover, strength));
  assert.ok(near > far);
  for (const t of [0, 0.12, hover, 0.7, 1]) {
    const back = undoLens(applyLens(t, hover, strength), hover, strength);
    assert.ok(Math.abs(back - t) < 1e-8, `${t} -> ${back}`);
  }
});

test("composed page map with lens round-trips", () => {
  const opts = { focus: 18, n: 60, hoverT: 0.3, lens: 0.8 };
  for (const page of [1, 18, 19, 40, 60]) {
    const back = unmapT(mapPage(page, opts), opts);
    assert.ok(Math.abs(back - page) < 1e-5, `${page} -> ${back}`);
  }
});

test("find hits sit on the page they match, not the page tick", () => {
  assert.equal(pageCoord(4, 0, 200), 4);
  assert.equal(pageCoord(4, 100, 200), 4.5);
  assert.equal(pageCoord(4, 200, 200), 4.999);
  assert.equal(pageCoord(4, -8, 200), 4);
  assert.equal(pageCoord(4, 40, 0), 4);
  assert.equal(pageCoord(4, 40, null), 4);
});
