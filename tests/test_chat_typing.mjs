import assert from "node:assert/strict";
import { test } from "node:test";
import { shouldShowTyping } from "../.claude/skills/crux-viewer/scripts/viewer/rail_panes.mjs";

const user = { role: "user", text: "why does this hold?" };
const reply = { role: "assistant", text: "because…" };

test("dots show while the session is watching and we spoke last", () => {
  assert.equal(shouldShowTyping([user], true), true);
  assert.equal(shouldShowTyping([user, reply, user], true), true);
});

test("dots hide once the reply lands", () => {
  assert.equal(shouldShowTyping([user, reply], true), false);
  assert.equal(shouldShowTyping([reply], true), false);
});

test("dots hide with no messages", () => {
  assert.equal(shouldShowTyping([], true), false);
});

test("dots hide when the session is not watching", () => {
  assert.equal(shouldShowTyping([user], false), false);
  assert.equal(shouldShowTyping([user], undefined), false);
  assert.equal(shouldShowTyping([user, reply], false), false);
});

test("malformed payloads never show dots", () => {
  assert.equal(shouldShowTyping(undefined, true), false);
  assert.equal(shouldShowTyping(null, true), false);
  assert.equal(shouldShowTyping("user", true), false);
  assert.equal(shouldShowTyping({ 0: user, length: 1 }, true), false);
  assert.equal(shouldShowTyping([null], true), false);
  assert.equal(shouldShowTyping(["user"], true), false);
  assert.equal(shouldShowTyping([{}], true), false);
  assert.equal(shouldShowTyping([{ role: "User" }], true), false);
});
