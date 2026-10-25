import assert from "node:assert/strict";
import { test } from "node:test";
import {
  INKS,
  boxFromPoints,
  clipRangeRect,
  clientRectsToLocal,
  clientToLocal,
  cycleInk,
  itemCharSlices,
  normalizeSpan,
  parseMarks,
  runAxis,
  shiftCssBox,
  textLayerTransform,
  underlineMarkRect,
} from "../.claude/skills/crux-viewer/scripts/viewer/user_marks.mjs";

test("highlighter inks are a closed fluorescent set, not claim kinds", () => {
  assert.deepEqual(INKS, ["yellow", "mint", "sky", "pink", "violet"]);
  assert.equal(cycleInk("yellow"), "mint");
  assert.equal(cycleInk("violet"), "yellow");
  assert.equal(cycleInk("unknown"), "mint");
});

test("normalizeSpan orders a text range and drops empties", () => {
  assert.deepEqual(normalizeSpan(12, 4), { start: 4, end: 12 });
  assert.equal(normalizeSpan(5, 5), null);
  assert.equal(normalizeSpan(2.9, 8.1).start, 3);
});

test("boxFromPoints stores an unordered PDF rect", () => {
  assert.deepEqual(boxFromPoints(10, 40, 2, 8), { x1: 2, y1: 8, x2: 10, y2: 40 });
  assert.equal(boxFromPoints(1, 1, 1, 8), null);
});

test("parseMarks keeps valid user marks and drops junk", () => {
  const marks = parseMarks({
    v: 1,
    marks: [
      { id: "a", type: "highlight", page: 1, ink: "yellow", start: 0, end: 8 },
      { id: "b", type: "box", page: 2, ink: "mint", x1: 0, y1: 0, x2: 10, y2: 10 },
      { id: "c", type: "underline", page: 1, ink: "finding", start: 0, end: 3 },
      { id: "d", type: "highlight", page: 1, ink: "sky", start: 4, end: 4 },
      { type: "highlight", page: 1, ink: "sky", start: 1, end: 2 },
    ],
  });
  assert.equal(marks.length, 2);
  assert.equal(marks[0].id, "a");
  assert.equal(marks[1].type, "box");
});

test("clipRangeRect paints only the overlapping characters", () => {
  const rect = { left: 100, top: 10, width: 200, height: 12 };
  assert.deepEqual(clipRangeRect(rect, 10, 20, 10, 20), rect);
  assert.deepEqual(clipRangeRect(rect, 10, 20, 10, 15), {
    left: 100,
    top: 10,
    width: 100,
    height: 12,
  });
  assert.deepEqual(clipRangeRect(rect, 10, 20, 12, 16), {
    left: 140,
    top: 10,
    width: 80,
    height: 12,
  });
  assert.equal(clipRangeRect(rect, 10, 20, 20, 30), null);
  assert.equal(clipRangeRect(rect, 10, 10, 10, 15), null);
});

test("clipRangeRect follows a rotated run instead of always slicing left-to-right", () => {
  const tall = { left: 50, top: 10, width: 12, height: 200 };
  assert.deepEqual(clipRangeRect(tall, 10, 20, 10, 15, "y"), {
    left: 50,
    top: 10,
    width: 12,
    height: 100,
  });
  assert.deepEqual(clipRangeRect(tall, 10, 20, 10, 15, "y-reverse"), {
    left: 50,
    top: 110,
    width: 12,
    height: 100,
  });
  const wide = { left: 100, top: 10, width: 200, height: 12 };
  assert.deepEqual(clipRangeRect(wide, 10, 20, 10, 15, "x-reverse"), {
    left: 200,
    top: 10,
    width: 100,
    height: 12,
  });
});

test("runAxis picks the writing direction from the glyph advance", () => {
  assert.equal(runAxis(80, 2), "x");
  assert.equal(runAxis(-80, 2), "x-reverse");
  assert.equal(runAxis(2, 80), "y");
  assert.equal(runAxis(2, -80), "y-reverse");
});

test("itemCharSlices maps a mid-run find onto local glyph offsets", () => {
  const ranges = [
    { start: 0, end: 5 },
    { start: 6, end: 11 },
  ];
  assert.deepEqual(itemCharSlices(ranges, { start: 1, end: 4 }), [{ spanI: 0, from: 1, to: 4 }]);
  assert.deepEqual(itemCharSlices(ranges, { start: 3, end: 9 }), [
    { spanI: 0, from: 3, to: 5 },
    { spanI: 1, from: 0, to: 3 },
  ]);
  assert.deepEqual(itemCharSlices([{ start: 0, end: 0 }, { start: 0, end: 4 }], { start: 1, end: 3 }), [
    { spanI: 0, from: 1, to: 3 },
  ]);
});

test("clientRectsToLocal undoes a parent CSS scale like find overlay coordinates", () => {
  const bounds = { left: 100, top: 50, width: 400, height: 200 };
  const localW = 800;
  const localH = 400;
  const rects = clientRectsToLocal(bounds, localW, localH, [
    { left: 150, top: 70, right: 200, bottom: 90, width: 50, height: 20 },
  ]);
  assert.equal(rects.length, 1);
  assert.equal(rects[0].left, 100);
  assert.equal(rects[0].top, 40);
  assert.equal(rects[0].width, 100);
  assert.equal(rects[0].height, 40);
});

test("underline sits below the glyph box, not through the letters", () => {
  const glyph = { left: 40, top: 80, width: 120, height: 16 };
  const ul = underlineMarkRect(glyph);
  assert.equal(ul.left, 40);
  assert.equal(ul.width, 120);
  assert.ok(ul.top >= glyph.top + glyph.height);
  assert.ok(ul.height > 0 && ul.height < glyph.height);
});

test("underline stays on the descent side after a 90 degree page rotate", () => {
  const vertical = { left: 80, top: 20, width: 16, height: 120 };
  const right = underlineMarkRect(vertical, { upX: -1, upY: 0 });
  assert.ok(right.left >= vertical.left + vertical.width);
  assert.equal(right.top, 20);
  assert.equal(right.height, 120);
  assert.ok(right.width < vertical.width);
  const left = underlineMarkRect(vertical, { upX: 1, upY: 0 });
  assert.ok(left.left + left.width <= vertical.left);
  const flipped = underlineMarkRect({ left: 40, top: 80, width: 120, height: 16 }, { upX: 0, upY: 1 });
  assert.ok(flipped.top + flipped.height <= 80);
});

test("clientToLocal undoes a parent CSS scale so a pointer stays on the glyph", () => {
  const bounds = { left: 200, top: 40, width: 400, height: 500 };
  const localW = 800;
  const localH = 1000;
  assert.deepEqual(clientToLocal(bounds, localW, localH, 200, 40), { x: 0, y: 0 });
  assert.deepEqual(clientToLocal(bounds, localW, localH, 400, 290), { x: 400, y: 500 });
  const unscaled = { left: 10, top: 20, width: 200, height: 100 };
  assert.deepEqual(clientToLocal(unscaled, 200, 100, 30, 40), { x: 20, y: 20 });
});

test("shiftCssBox moves a highlight box and stays on the page", () => {
  const box = { left: 40, top: 80, width: 100, height: 50 };
  assert.deepEqual(shiftCssBox(box, 10, -20, { width: 400, height: 300 }), {
    left: 50,
    top: 60,
    width: 100,
    height: 50,
  });
  assert.equal(shiftCssBox(box, -100, 0, { width: 400, height: 300 }).left, 0);
  assert.equal(shiftCssBox(box, 500, 500, { width: 400, height: 300 }).left, 300);
  assert.equal(shiftCssBox(box, 500, 500, { width: 400, height: 300 }).top, 250);
});

test("textLayerTransform mirrors the official viewer's rotation compensation", () => {
  assert.equal(textLayerTransform(0), "");
  assert.equal(textLayerTransform(90), "rotate(90deg) translateY(-100%)");
  assert.equal(textLayerTransform(180), "rotate(180deg) translate(-100%, -100%)");
  assert.equal(textLayerTransform(270), "rotate(270deg) translateX(-100%)");
  assert.equal(textLayerTransform(450), textLayerTransform(90));
  assert.equal(textLayerTransform(-90), textLayerTransform(270));
  assert.equal(textLayerTransform(undefined), "");
  assert.equal(textLayerTransform("nonsense"), "");
});
