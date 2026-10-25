import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RAIL_DEFAULT,
  STAGE_MIN,
  clampRailWidth,
  defaultRailWidth,
  railCap,
  stageWidth,
} from "../.claude/skills/crux-viewer/scripts/viewer/rail_layout.mjs";

test("claims pane never consumes the whole window", () => {
  assert.equal(railCap(1200), 1200 - STAGE_MIN);
  assert.equal(clampRailWidth(5000, 1200), 1200 - STAGE_MIN);
  assert.equal(stageWidth(clampRailWidth(5000, 1200), 1200), STAGE_MIN);
});

test("a fresh session opens at the default width with the reader still visible", () => {
  assert.equal(defaultRailWidth(1400), RAIL_DEFAULT);
  assert.ok(stageWidth(defaultRailWidth(1400), 1400) >= STAGE_MIN);
  assert.ok(defaultRailWidth(1400) < 1400);
});

test("a narrow window shrinks claims instead of covering the reader", () => {
  const shell = STAGE_MIN + 80;
  const w = defaultRailWidth(shell);
  assert.equal(w, 80);
  assert.equal(stageWidth(w, shell), STAGE_MIN);
});
