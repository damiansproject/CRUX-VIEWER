import assert from "node:assert/strict";
import { test } from "node:test";
import { createLocationHistory } from "../.claude/skills/crux-viewer/scripts/viewer/location_history.mjs";

test("a jump remembers where the reader was, and back pops it", () => {
  const hist = createLocationHistory();
  assert.equal(hist.size, 0);
  hist.remember({ page: 1, top: 0 });
  hist.remember({ page: 4, top: 3200 });
  assert.equal(hist.size, 2);
  assert.deepEqual(hist.pop(), { page: 4, top: 3200 });
  assert.deepEqual(hist.pop(), { page: 1, top: 0 });
  assert.equal(hist.pop(), undefined);
  assert.equal(hist.size, 0);
});

test("re-remembering the same spot does not stack duplicates", () => {
  const hist = createLocationHistory({ nearPx: 16 });
  hist.remember({ page: 2, top: 1000 });
  hist.remember({ page: 2, top: 1010 });
  assert.equal(hist.size, 1);
  hist.remember({ page: 2, top: 1040 });
  assert.equal(hist.size, 2);
});

test("the stack is capped at the limit, dropping the oldest", () => {
  const hist = createLocationHistory({ limit: 3, nearPx: 0 });
  for (let i = 1; i <= 5; i += 1) hist.remember({ page: i, top: i * 100 });
  assert.equal(hist.size, 3);
  assert.deepEqual(hist.pop(), { page: 5, top: 500 });
  assert.deepEqual(hist.pop(), { page: 4, top: 400 });
  assert.deepEqual(hist.pop(), { page: 3, top: 300 });
  assert.equal(hist.pop(), undefined);
});

test("a snapshot without a page is refused", () => {
  const hist = createLocationHistory();
  hist.remember({ top: 10 });
  hist.remember(null);
  assert.equal(hist.size, 0);
});

test("extra fields such as the fractional anchor ride along with the snapshot", () => {
  const hist = createLocationHistory();
  hist.remember({ page: 3, top: 2400, anchor: 3.41 });
  assert.deepEqual(hist.pop(), { page: 3, top: 2400, anchor: 3.41 });
});
