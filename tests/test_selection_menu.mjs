import assert from "node:assert/strict";
import { test } from "node:test";
import {
  addAttachment,
  chipLabel,
  clampMenuPos,
  clipPreview,
  clipboardPngItems,
  cropBoxSource,
  dropAttachment,
  menuActions,
  parseAttachments,
  pngBlobFromDataUrl,
  quoteFromMark,
  quoteFromSelection,
  rightClickAction,
  spanFromDomRange,
} from "../.claude/skills/crux-viewer/scripts/viewer/selection_menu.mjs";

test("right-click menu only follows the selected highlight, not the topmost overlay", () => {
  assert.equal(
    rightClickAction({ selectedType: "highlight", onSelected: false, hasNative: false }),
    null
  );
  assert.equal(
    rightClickAction({ selectedType: "highlight", onSelected: true, hasNative: true }),
    "mark"
  );
  assert.equal(
    rightClickAction({ selectedType: "claim", onSelected: true, hasNative: false }),
    "mark"
  );
  assert.equal(
    rightClickAction({ selectedType: "box", onSelected: true, hasNative: false }),
    "box"
  );
  assert.equal(
    rightClickAction({ selectedType: "box", onSelected: false, hasNative: false }),
    null
  );
  assert.equal(
    rightClickAction({ selectedType: null, onSelected: false, hasNative: true }),
    "native"
  );
});

test("selection menu lists highlight, underline, copy, and attach", () => {
  assert.deepEqual(
    menuActions("pdf").map((a) => a.id),
    ["highlight", "underline", "copy", "attach"]
  );
  assert.deepEqual(
    menuActions("web").map((a) => a.id),
    ["copy", "attach"]
  );
  assert.deepEqual(
    menuActions("mark").map((a) => a.id),
    ["copy", "attach"]
  );
  assert.deepEqual(
    menuActions("box").map((a) => a.id),
    ["save-image", "copy-image", "attach-image"]
  );
});

test("quoteFromSelection keeps a page and collapses whitespace", () => {
  assert.deepEqual(quoteFromSelection("  fire\nfrequency  ", 12), {
    text: "fire frequency",
    page: 12,
  });
  assert.equal(quoteFromSelection("   ", 1), null);
  assert.deepEqual(quoteFromSelection("hello", "nope"), { text: "hello" });
});

test("spanFromDomRange maps a mid-run selection onto haystack offsets", () => {
  const a = { id: "a" };
  const b = { id: "b" };
  const pairs = [
    { range: { start: 0, end: 5 }, el: a },
    { range: { start: 6, end: 11 }, el: b },
  ];
  const locate = (node) => node.el;
  assert.deepEqual(
    spanFromDomRange(
      { startContainer: { el: a, nodeType: 3 }, startOffset: 1, endContainer: { el: b, nodeType: 3 }, endOffset: 3 },
      pairs,
      locate
    ),
    { start: 1, end: 9 }
  );
  assert.equal(
    spanFromDomRange(
      { startContainer: { el: a, nodeType: 3 }, startOffset: 2, endContainer: { el: a, nodeType: 3 }, endOffset: 2 },
      pairs,
      locate
    ),
    null
  );
});

test("parseAttachments keeps page quotes and drops junk", () => {
  assert.deepEqual(
    parseAttachments([
      { text: "alpha", page: 3 },
      { text: "  ", page: 1 },
      { text: "beta" },
      null,
    ]),
    [
      { text: "alpha", page: 3 },
      { text: "beta" },
    ]
  );
});

test("attachment queue skips duplicates and can drop a chip", () => {
  let list = [];
  list = addAttachment(list, { text: "one", page: 2 });
  list = addAttachment(list, { text: "one", page: 2 });
  list = addAttachment(list, { text: "two", page: 4 });
  assert.equal(list.length, 2);
  assert.deepEqual(dropAttachment(list, 0).map((a) => a.text), ["two"]);
});

test("clipPreview truncates a long quote for the chip", () => {
  assert.equal(clipPreview("short"), "short");
  assert.equal(clipPreview("abcdefghij", 8), "abcdefg…");
});

test("clampMenuPos keeps the menu on screen", () => {
  assert.deepEqual(clampMenuPos(10, 10, 160, 140, 800, 600), { left: 10, top: 10 });
  assert.deepEqual(clampMenuPos(780, 590, 160, 140, 800, 600, 8), { left: 632, top: 452 });
});

test("quoteFromMark copies the highlighted run, not the whole line", () => {
  const haystack = "hello fire frequency world";
  assert.deepEqual(quoteFromMark(haystack, { type: "highlight", page: 2, start: 6, end: 20 }), {
    text: "fire frequency",
    page: 2,
  });
  assert.deepEqual(quoteFromMark(haystack, { type: "underline", page: 1, start: 0, end: 5 }), {
    text: "hello",
    page: 1,
  });
  assert.equal(quoteFromMark(haystack, { type: "box", page: 1, start: 0, end: 5 }), null);
  assert.equal(quoteFromMark(haystack, { type: "highlight", page: 1, start: 4, end: 4 }), null);
});

test("cropBoxSource maps a CSS box onto the page canvas pixels", () => {
  const src = cropBoxSource({ left: 10, top: 20, width: 50, height: 40 }, 100, 80, 200, 160);
  assert.deepEqual(src, { sx: 20, sy: 40, sw: 100, sh: 80 });
  assert.equal(cropBoxSource({ left: 0, top: 0, width: 0, height: 10 }, 100, 80, 200, 160), null);
});

test("image attachments queue as chips without a text quote", () => {
  const png = "data:image/png;base64,aaa";
  let list = addAttachment([], { type: "image", page: 3, data: png, name: "Box" });
  list = addAttachment(list, { type: "image", page: 3, data: png, name: "Box" });
  assert.equal(list.length, 1);
  assert.equal(list[0].type, "image");
  assert.equal(chipLabel(list[0]), "p.3 · Box");
  assert.deepEqual(parseAttachments([{ type: "image", page: 3, file: "literature_chat/p_one_files/a.png", name: "a.png" }]), [
    { type: "image", page: 3, file: "literature_chat/p_one_files/a.png", name: "a.png" },
  ]);
});

test("pngBlobFromDataUrl rebuilds a PNG so copy can stay on the click", async () => {
  const dataUrl =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const blob = pngBlobFromDataUrl(dataUrl);
  assert.equal(blob.type, "image/png");
  const bytes = new Uint8Array(await blob.arrayBuffer());
  assert.deepEqual([...bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(pngBlobFromDataUrl("not-a-png"), null);
});

test("clipboard PNG payload is a promise so write keeps the user gesture", async () => {
  const blob = pngBlobFromDataUrl(
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="
  );
  const items = clipboardPngItems(blob);
  assert.equal(typeof items["image/png"].then, "function");
  assert.equal(await items["image/png"], blob);
});
